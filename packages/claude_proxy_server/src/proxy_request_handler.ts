import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { once } from 'node:events';
import {
  AnthropicMessageStreamAssembler,
  readAssembledMessageText,
  readAssembledMessageToolText,
  type AssembledMessage,
} from './anthropic_message_stream_assembler.ts';
import { subscriptionRouteName } from './api_key_routes_config.ts';
import { extractClaudeCodeRequestContext } from './claude_code_request_context.ts';
import {
  estimateMessageCostUsd,
  findModelTokenPrices,
  readMessageTokenUsage,
  type ModelPricingTable,
} from './model_pricing_config.ts';
import type { ClientAuthKind, CompletedProxiedRequest, RequestDatabase, RouteKind } from './request_database.ts';
import type { RoutingState, UpstreamRoute } from './routing_state.ts';
import { readSubscriptionWeeklyRateLimit } from './subscription_rate_limit_headers.ts';
import { readIncomingBody, sendUpstreamHttpRequest } from './upstream_http_request.ts';

type UpstreamTarget = UpstreamRoute | { routeKind: 'passthrough' };

export interface ProxyRequestHandlerDependencies {
  requestDatabase: RequestDatabase;
  routingState: RoutingState;
  readModelPricingTable: () => ModelPricingTable;
  /** The Anthropic API base URL for subscription and passthrough traffic, normally https://api.anthropic.com. */
  anthropicBaseUrl: string;
  /** Receives each OAuth access token that Claude Code sends, for the subscription usage check. */
  rememberSubscriptionAccessToken: (accessToken: string) => void;
}

const requestHeadersNotForwarded = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'content-length', 'accept-encoding',
]);
/**
 * The proxy records only these paths and forwards every other path unrecorded. Through `HTTPS_PROXY`, Claude Code
 * also sends bootstrap, plugin, telemetry and Remote Control polling requests, which the proxy does not use.
 */
const recordedRequestPaths = new Set(['/v1/messages', '/v1/messages/count_tokens', '/v1/models', '/api/hello']);
const responseHeadersNotForwarded =new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);

/**
 * Forwards one client request to Anthropic and records it.
 * Subscription (OAuth) requests to `/v1/messages` follow the routing plan: the proxy moves to the next route
 * when the subscription rejects a request for the weekly limit, or when an API key returns 401.
 * The proxy can retry only before it sends anything to the client, and failover responses are never streamed.
 */
export async function handleProxyRequest(
  clientRequest: IncomingMessage,
  clientResponse: ServerResponse,
  dependencies: ProxyRequestHandlerDependencies,
): Promise<void> {
  const { requestDatabase, routingState } = dependencies;
  const startedAtMs = Date.now();
  const requestBody = await readIncomingBody(clientRequest);
  const requestUrl = new URL(clientRequest.url ?? '/', 'http://claude-proxy');
  const clientAuthKind = readClientAuthKind(clientRequest.headers);

  const bearerToken = /^Bearer\s+(.+)$/i.exec(clientRequest.headers.authorization ?? '')?.[1];
  if (bearerToken) dependencies.rememberSubscriptionAccessToken(bearerToken);

  const requestContext = extractClaudeCodeRequestContext(clientRequest.headers, parseJsonOrNull(requestBody.toString('utf8')));
  const proxiedRequestId = !recordedRequestPaths.has(requestUrl.pathname) ? null : recordSafely(() =>
    requestDatabase.insertStartedRequest({
      startedAt: new Date(startedAtMs).toISOString(),
      httpMethod: clientRequest.method ?? 'GET',
      requestPath: `${requestUrl.pathname}${requestUrl.search}`,
      clientAuthKind,
      model: requestContext.model,
      isStreaming: requestContext.isStreaming,
      sessionId: requestContext.sessionId,
      projectPath: requestContext.projectPath,
      requestHeadersJson: JSON.stringify(redactCredentialHeaders(clientRequest.headers)),
      requestBody,
      lastUserMessageText: requestContext.lastUserMessageText,
      lastUserMessageToolResultText: requestContext.lastUserMessageToolResultText,
    }),
  );
  const completeRecordedRequest = (completedRequest: CompletedProxiedRequest) => {
    if (proxiedRequestId !== null) recordSafely(() => requestDatabase.completeRequest(proxiedRequestId, completedRequest));
  };

  const isSwitchableSubscriptionRequest = clientAuthKind === 'oauth' && requestUrl.pathname.startsWith('/v1/messages');
  const upstreamTargets: UpstreamTarget[] = isSwitchableSubscriptionRequest
    ? routingState.planUpstreamRoutes()
    : [clientAuthKind === 'oauth' ? { routeKind: 'subscription' } : { routeKind: 'passthrough' }];

  const abortController = new AbortController();
  clientResponse.on('close', () => {
    if (!clientResponse.writableFinished) abortController.abort();
  });

  for (const [targetIndex, upstreamTarget] of upstreamTargets.entries()) {
    const { routeKind, routeName, baseUrl } = describeUpstreamTarget(upstreamTarget, dependencies.anthropicBaseUrl);
    const upstreamUrl = new URL(`${baseUrl}${requestUrl.pathname}${requestUrl.search}`);
    const attemptStartedAtMs = Date.now();
    const recordAttempt = (statusCode: number | null, errorBody: string | null) => {
      if (proxiedRequestId === null) return;
      recordSafely(() =>
        requestDatabase.insertUpstreamAttempt({
          proxiedRequestId,
          attemptNumber: targetIndex + 1,
          routeKind,
          routeName,
          upstreamUrl: upstreamUrl.toString(),
          statusCode,
          errorBody,
          startedAt: new Date(attemptStartedAtMs).toISOString(),
          durationMs: Date.now() - attemptStartedAtMs,
        }),
      );
    };

    let upstreamResponse: IncomingMessage;
    try {
      upstreamResponse = await sendUpstreamHttpRequest(
        upstreamUrl,
        clientRequest.method ?? 'GET',
        buildUpstreamHeaders(clientRequest.headers, upstreamTarget, requestBody),
        requestBody,
        abortController.signal,
      );
    } catch (error) {
      const errorMessage = (error as Error).message;
      recordAttempt(null, errorMessage);
      const errorType = abortController.signal.aborted ? 'client_aborted' : 'upstream_connection_error';
      completeRecordedRequest(emptyCompletedRequest(startedAtMs, routeKind, routeName, null, errorType));
      if (!abortController.signal.aborted) sendProxyError(clientResponse, 502, `claude-proxy could not reach ${upstreamUrl.origin}: ${errorMessage}`);
      return;
    }

    const statusCode = upstreamResponse.statusCode ?? 502;
    let shouldTryNextTarget = false;
    if (upstreamTarget.routeKind === 'subscription') {
      const weeklyRateLimit = readSubscriptionWeeklyRateLimit(statusCode, upstreamResponse.headers);
      recordSafely(() => routingState.recordSubscriptionWeeklyRateLimit(weeklyRateLimit));
      shouldTryNextTarget = weeklyRateLimit.isWeeklyLimitRejection;
    } else if (upstreamTarget.routeKind === 'api_key') {
      shouldTryNextTarget = statusCode === 401;
    }

    if (shouldTryNextTarget && targetIndex < upstreamTargets.length - 1) {
      const errorBody = await readIncomingBody(upstreamResponse).then(
        (responseBody) => responseBody.toString('utf8'),
        (error: Error) => error.message,
      );
      recordAttempt(statusCode, errorBody);
      continue;
    }

    recordAttempt(statusCode, null);
    await forwardUpstreamResponse(upstreamResponse, clientResponse, routeName, abortController.signal).then(
      (forwardedResponse) => {
        const completedRequest = summariseForwardedResponse(
          forwardedResponse,
          requestContext.model,
          dependencies.readModelPricingTable(),
        );
        completeRecordedRequest({
          ...emptyCompletedRequest(startedAtMs, routeKind, routeName, statusCode, completedRequest.errorType),
          ...completedRequest,
          responseHeadersJson: JSON.stringify(upstreamResponse.headers),
        });
      },
      (error: Error) => {
        const errorType = abortController.signal.aborted ? 'client_aborted' : 'upstream_stream_error';
        console.error(`Proxied request ${proxiedRequestId} failed while streaming: ${error.message}`);
        completeRecordedRequest({
          ...emptyCompletedRequest(startedAtMs, routeKind, routeName, statusCode, errorType),
          responseHeadersJson: JSON.stringify(upstreamResponse.headers),
        });
        clientResponse.destroy();
      },
    );
    return;
  }
}

interface ForwardedResponse {
  isEventStream: boolean;
  assembledMessage: AssembledMessage | null;
  streamError: unknown;
  responseBodyText: string;
}

/** Copies the upstream response to the client chunk by chunk, and keeps a copy for the request record. */
async function forwardUpstreamResponse(
  upstreamResponse: IncomingMessage,
  clientResponse: ServerResponse,
  routeName: string,
  abortSignal: AbortSignal,
): Promise<ForwardedResponse> {
  const forwardedHeaders: OutgoingHttpHeaders = { 'x-claude-proxy-route': routeName };
  for (const [headerName, headerValue] of Object.entries(upstreamResponse.headers)) {
    if (!responseHeadersNotForwarded.has(headerName) && headerValue !== undefined) forwardedHeaders[headerName] = headerValue;
  }
  clientResponse.writeHead(upstreamResponse.statusCode ?? 502, forwardedHeaders);

  const isEventStream = String(upstreamResponse.headers['content-type'] ?? '').includes('text/event-stream');
  const streamAssembler = isEventStream ? new AnthropicMessageStreamAssembler() : null;
  const bodyChunks: Buffer[] = [];
  for await (const responseChunk of upstreamResponse) {
    if (abortSignal.aborted) throw new Error('Client closed the connection');
    if (streamAssembler) streamAssembler.pushChunk(responseChunk as Buffer);
    else bodyChunks.push(responseChunk as Buffer);
    if (!clientResponse.write(responseChunk)) await once(clientResponse, 'drain', { signal: abortSignal });
  }
  clientResponse.end();

  if (streamAssembler) {
    const { message, streamError } = streamAssembler.finish();
    return {
      isEventStream,
      assembledMessage: message,
      streamError,
      responseBodyText: JSON.stringify(streamError ? { ...message, stream_error: streamError } : message),
    };
  }
  const responseBodyText = Buffer.concat(bodyChunks).toString('utf8');
  return { isEventStream, assembledMessage: null, streamError: null, responseBodyText };
}

function summariseForwardedResponse(
  forwardedResponse: ForwardedResponse,
  requestModel: string | null,
  modelPricingTable: ModelPricingTable,
): Partial<CompletedProxiedRequest> & { errorType: string | null } {
  const responseJson = forwardedResponse.assembledMessage ?? parseJsonOrNull(forwardedResponse.responseBodyText);
  const responseFields = (typeof responseJson === 'object' && responseJson !== null ? responseJson : {}) as Record<string, any>;
  const errorType =
    (forwardedResponse.streamError as { type?: string } | null)?.type ??
    (responseFields.type === 'error' ? (responseFields.error?.type ?? 'error') : null);

  const tokenUsage = readMessageTokenUsage(responseFields.usage);
  const model = typeof responseFields.model === 'string' ? responseFields.model : requestModel;
  const modelTokenPrices = model ? findModelTokenPrices(modelPricingTable, model) : null;
  const isMessageResponse = responseFields.type === 'message';

  return {
    errorType,
    stopReason: typeof responseFields.stop_reason === 'string' ? responseFields.stop_reason : null,
    inputTokens: tokenUsage?.inputTokens ?? (typeof responseFields.input_tokens === 'number' ? responseFields.input_tokens : null),
    outputTokens: tokenUsage?.outputTokens ?? null,
    cacheCreation5mInputTokens: tokenUsage?.cacheCreation5mInputTokens ?? null,
    cacheCreation1hInputTokens: tokenUsage?.cacheCreation1hInputTokens ?? null,
    cacheReadInputTokens: tokenUsage?.cacheReadInputTokens ?? null,
    estimatedCostUsd: isMessageResponse && tokenUsage && modelTokenPrices ? estimateMessageCostUsd(modelTokenPrices, tokenUsage) : null,
    responseBody: forwardedResponse.responseBodyText,
    responseText: isMessageResponse ? readAssembledMessageText(responseFields as AssembledMessage) : '',
    responseToolText: isMessageResponse ? readAssembledMessageToolText(responseFields as AssembledMessage) : '',
  };
}

function describeUpstreamTarget(
  upstreamTarget: UpstreamTarget,
  anthropicBaseUrl: string,
): { routeKind: RouteKind; routeName: string; baseUrl: string } {
  switch (upstreamTarget.routeKind) {
    case 'subscription':
      return { routeKind: 'subscription', routeName: subscriptionRouteName, baseUrl: anthropicBaseUrl };
    case 'passthrough':
      return { routeKind: 'passthrough', routeName: 'passthrough', baseUrl: anthropicBaseUrl };
    case 'api_key':
      return { routeKind: 'api_key', routeName: upstreamTarget.apiKeyRoute.name, baseUrl: upstreamTarget.apiKeyRoute.baseUrl };
  }
}

/**
 * Copies the client headers. For an API key route it replaces the OAuth token with the route's API key
 * and removes the OAuth beta flag, which the API rejects with an API key.
 */
function buildUpstreamHeaders(clientHeaders: IncomingHttpHeaders, upstreamTarget: UpstreamTarget, requestBody: Buffer): OutgoingHttpHeaders {
  const upstreamHeaders: OutgoingHttpHeaders = {};
  for (const [headerName, headerValue] of Object.entries(clientHeaders)) {
    if (!requestHeadersNotForwarded.has(headerName) && headerValue !== undefined) upstreamHeaders[headerName] = headerValue;
  }
  if (requestBody.length > 0) upstreamHeaders['content-length'] = requestBody.length;

  if (upstreamTarget.routeKind === 'api_key') {
    delete upstreamHeaders.authorization;
    upstreamHeaders['x-api-key'] = upstreamTarget.apiKeyRoute.apiKey;
    const betaFlags = String(clientHeaders['anthropic-beta'] ?? '')
      .split(',')
      .map((betaFlag) => betaFlag.trim())
      .filter((betaFlag) => betaFlag !== '' && !betaFlag.startsWith('oauth-'));
    if (betaFlags.length > 0) upstreamHeaders['anthropic-beta'] = betaFlags.join(',');
    else delete upstreamHeaders['anthropic-beta'];
  }
  return upstreamHeaders;
}

function readClientAuthKind(clientHeaders: IncomingHttpHeaders): ClientAuthKind {
  if (/^Bearer\s/i.test(clientHeaders.authorization ?? '')) return 'oauth';
  if (clientHeaders['x-api-key']) return 'api_key';
  return 'none';
}

function redactCredentialHeaders(clientHeaders: IncomingHttpHeaders): IncomingHttpHeaders {
  const redactedHeaders = { ...clientHeaders };
  if (redactedHeaders.authorization) redactedHeaders.authorization = 'Bearer [redacted]';
  if (redactedHeaders['x-api-key']) redactedHeaders['x-api-key'] = '[redacted]';
  return redactedHeaders;
}

function emptyCompletedRequest(
  startedAtMs: number,
  routeKind: RouteKind,
  routeName: string,
  statusCode: number | null,
  errorType: string | null,
): CompletedProxiedRequest {
  return {
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    routeKind,
    routeName,
    statusCode,
    errorType,
    stopReason: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreation5mInputTokens: null,
    cacheCreation1hInputTokens: null,
    cacheReadInputTokens: null,
    estimatedCostUsd: null,
    responseHeadersJson: null,
    responseBody: null,
    responseText: '',
    responseToolText: '',
  };
}

function sendProxyError(clientResponse: ServerResponse, statusCode: number, message: string): void {
  if (clientResponse.headersSent) {
    clientResponse.destroy();
    return;
  }
  clientResponse.writeHead(statusCode, { 'content-type': 'application/json' });
  clientResponse.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}

/** Runs a database write. A failed write is logged and never stops the request from being proxied. */
function recordSafely<ResultType>(databaseWrite: () => ResultType): ResultType | null {
  try {
    return databaseWrite();
  } catch (error) {
    console.error(`claude-proxy could not write to the request database: ${(error as Error).message}`);
    return null;
  }
}

function parseJsonOrNull(jsonText: string): unknown {
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}
