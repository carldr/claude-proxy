import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { once } from 'node:events';
import {
  AnthropicMessageStreamAssembler,
  readAssembledMessageText,
  readAssembledMessageToolText,
  type AssembledMessage,
} from './anthropic_message_stream_assembler.ts';
import { extractClaudeCodeRequestContext, type ClaudeCodeRequestContext } from './claude_code_request_context.ts';
import {
  estimateMessageCostUsd,
  findModelTokenPrices,
  readMessageTokenUsage,
  type ModelPricingTable,
} from './model_pricing_config.ts';
import type { ClientAuthKind, CompletedProxiedRequest, RequestDatabase, RouteKind } from './request_database.ts';
import type { PlannedSubscriptionAccountRoute, SubscriptionAccountRouter } from './subscription_account_router.ts';
import { readSubscriptionRateLimit } from './subscription_rate_limit_headers.ts';
import { readIncomingBody, sendUpstreamHttpRequest } from './upstream_http_request.ts';

type UpstreamTarget =
  | { routeKind: 'subscription_account'; plannedRoute: PlannedSubscriptionAccountRoute }
  | { routeKind: 'subscription' }
  | { routeKind: 'passthrough' };

/** An upstream response that the proxy forwards to the client, either as it arrives or after a later route also rejects. */
interface UpstreamResponseToForward {
  routeKind: RouteKind;
  routeName: string;
  statusCode: number;
  headers: IncomingHttpHeaders;
  responseBody: AsyncIterable<Buffer> | Iterable<Buffer>;
}

export interface ProxyRequestHandlerDependencies {
  requestDatabase: RequestDatabase;
  subscriptionAccountRouter: SubscriptionAccountRouter;
  readModelPricingTable: () => ModelPricingTable;
  /** The Anthropic API base URL, normally https://api.anthropic.com. */
  anthropicBaseUrl: string;
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
 * Subscription (OAuth) requests to `/v1/messages` follow the plan of `SubscriptionAccountRouter`. The proxy moves to the
 * next subscription account when an account rejects the request for a 5-hour, weekly or per-model weekly limit.
 * The proxy can retry only before it sends anything to the client, and failover responses are never streamed.
 * When every route rejects, the client gets the rejection of the project's own account, if the plan has that account.
 */
export async function handleProxyRequest(
  clientRequest: IncomingMessage,
  clientResponse: ServerResponse,
  dependencies: ProxyRequestHandlerDependencies,
): Promise<void> {
  const { requestDatabase, subscriptionAccountRouter } = dependencies;
  const startedAtMs = Date.now();
  // The listener starts before the first await, so that a client that closes during planning also aborts the request.
  const abortController = new AbortController();
  clientResponse.on('close', () => {
    if (!clientResponse.writableFinished) abortController.abort();
  });
  const requestBody = await readIncomingBody(clientRequest);
  const requestUrl = new URL(clientRequest.url ?? '/', 'http://claude-proxy');
  const clientAuthKind = readClientAuthKind(clientRequest.headers);

  const requestContext = extractClaudeCodeRequestContext(clientRequest.headers, parseJsonOrNull(requestBody.toString('utf8')));
  const isSubscriptionAccountRoutedRequest = clientAuthKind === 'oauth' && requestUrl.pathname.startsWith('/v1/messages');
  // Planning runs before insertStartedRequest, so that the project lookup cannot find the request itself.
  const plannedRoutes = isSubscriptionAccountRoutedRequest
    ? await planSubscriptionAccountRoutesSafely(requestDatabase, subscriptionAccountRouter, requestContext)
    : [];
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
      previousUpstreamRequestId: requestContext.previousUpstreamRequestId,
      requestHeadersJson: JSON.stringify(redactCredentialHeaders(clientRequest.headers)),
      requestBody,
      lastUserMessageText: requestContext.lastUserMessageText,
      lastUserMessageToolResultText: requestContext.lastUserMessageToolResultText,
    }),
  );
  const completeRecordedRequest = (completedRequest: CompletedProxiedRequest) => {
    if (proxiedRequestId !== null) recordSafely(() => requestDatabase.completeRequest(proxiedRequestId, completedRequest));
  };

  const upstreamTargets: UpstreamTarget[] =
    plannedRoutes.length > 0
      ? plannedRoutes.map((plannedRoute) => ({ routeKind: 'subscription_account', plannedRoute }))
      : [clientAuthKind === 'oauth' ? { routeKind: 'subscription' } : { routeKind: 'passthrough' }];

  const forwardAndCompleteRequest = async (upstreamResponseToForward: UpstreamResponseToForward) => {
    const { routeKind, routeName, statusCode, headers } = upstreamResponseToForward;
    await forwardUpstreamResponse(upstreamResponseToForward, clientResponse, abortController.signal).then(
      (forwardedResponse) => {
        const completedRequest = summariseForwardedResponse(
          forwardedResponse,
          requestContext.model,
          dependencies.readModelPricingTable(),
        );
        completeRecordedRequest({
          ...emptyCompletedRequest(startedAtMs, routeKind, routeName, statusCode, completedRequest.errorType),
          ...completedRequest,
          responseHeadersJson: JSON.stringify(headers),
        });
      },
      (error: Error) => {
        const errorType = abortController.signal.aborted ? 'client_aborted' : 'upstream_stream_error';
        console.error(`Proxied request ${proxiedRequestId} failed while streaming: ${error.message}`);
        completeRecordedRequest({
          ...emptyCompletedRequest(startedAtMs, routeKind, routeName, statusCode, errorType),
          responseHeadersJson: JSON.stringify(headers),
        });
        clientResponse.destroy();
      },
    );
  };

  // The proxy holds the rejection of the project's own account, and forwards it when the last route also rejects.
  let projectSubscriptionAccountRejection: UpstreamResponseToForward | null = null;
  for (const [targetIndex, upstreamTarget] of upstreamTargets.entries()) {
    const { routeKind, routeName } = describeUpstreamTarget(upstreamTarget);
    const upstreamUrl = new URL(`${dependencies.anthropicBaseUrl}${requestUrl.pathname}${requestUrl.search}`);
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
    if (upstreamTarget.routeKind === 'subscription_account') {
      const rateLimit = readSubscriptionRateLimit(statusCode, upstreamResponse.headers, new Date());
      // Claude Code's own token can belong to another account, so only a response to the account's grant updates its usage and blocks.
      if (upstreamTarget.plannedRoute.accessToken !== null) {
        recordSafely(() =>
          subscriptionAccountRouter.recordResponse(upstreamTarget.plannedRoute.subscriptionAccountName, requestContext.model, rateLimit),
        );
      }
      shouldTryNextTarget = rateLimit.rejection !== null;
    }

    const isLastTarget = targetIndex === upstreamTargets.length - 1;
    if (shouldTryNextTarget && (!isLastTarget || projectSubscriptionAccountRejection !== null)) {
      const rejectedResponseBody = await readIncomingBody(upstreamResponse).catch((error: Error) => error);
      recordAttempt(statusCode, rejectedResponseBody instanceof Error ? rejectedResponseBody.message : rejectedResponseBody.toString('utf8'));
      if (
        upstreamTarget.routeKind === 'subscription_account' &&
        upstreamTarget.plannedRoute.isProjectSubscriptionAccount &&
        !(rejectedResponseBody instanceof Error)
      ) {
        projectSubscriptionAccountRejection = {
          routeKind,
          routeName,
          statusCode,
          headers: upstreamResponse.headers,
          responseBody: [rejectedResponseBody],
        };
      }
      if (!isLastTarget) continue;
      await forwardAndCompleteRequest(projectSubscriptionAccountRejection!);
      return;
    }

    recordAttempt(statusCode, null);
    await forwardAndCompleteRequest({ routeKind, routeName, statusCode, headers: upstreamResponse.headers, responseBody: upstreamResponse });
    return;
  }
}

/**
 * Returns the routes of `SubscriptionAccountRouter` for the request's project. A request without an environment block
 * takes its project from the conversation, so it goes to the same account. When the database or the router fails,
 * it logs the error and returns an empty plan. The request then goes upstream with Claude Code's own token.
 */
async function planSubscriptionAccountRoutesSafely(
  requestDatabase: RequestDatabase,
  subscriptionAccountRouter: SubscriptionAccountRouter,
  requestContext: ClaudeCodeRequestContext,
): Promise<PlannedSubscriptionAccountRoute[]> {
  try {
    const { projectPath } = requestDatabase.findProjectPath(
      requestContext.sessionId,
      requestContext.projectPath,
      requestContext.previousUpstreamRequestId,
    );
    return await subscriptionAccountRouter.planRoutes(projectPath, requestContext.model, new Date());
  } catch (error) {
    console.error(`claude-proxy could not plan the subscription account routes, and sends Claude Code's own token: ${(error as Error).message}`);
    return [];
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
  upstreamResponseToForward: UpstreamResponseToForward,
  clientResponse: ServerResponse,
  abortSignal: AbortSignal,
): Promise<ForwardedResponse> {
  const { routeName, statusCode, headers, responseBody } = upstreamResponseToForward;
  const forwardedHeaders: OutgoingHttpHeaders = { 'x-claude-proxy-route': routeName };
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (!responseHeadersNotForwarded.has(headerName) && headerValue !== undefined) forwardedHeaders[headerName] = headerValue;
  }
  clientResponse.writeHead(statusCode, forwardedHeaders);

  const isEventStream = String(headers['content-type'] ?? '').includes('text/event-stream');
  const streamAssembler = isEventStream ? new AnthropicMessageStreamAssembler() : null;
  const bodyChunks: Buffer[] = [];
  for await (const responseChunk of responseBody) {
    if (abortSignal.aborted) throw new Error('Client closed the connection');
    if (streamAssembler) streamAssembler.pushChunk(responseChunk);
    else bodyChunks.push(responseChunk);
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

/**
 * Names the route in the request record and in the `x-claude-proxy-route` header.
 * A subscription account without a live grant sends Claude Code's own token, so it counts as a `subscription` route.
 */
function describeUpstreamTarget(upstreamTarget: UpstreamTarget): { routeKind: RouteKind; routeName: string } {
  switch (upstreamTarget.routeKind) {
    case 'subscription_account':
      return upstreamTarget.plannedRoute.accessToken === null
        ? { routeKind: 'subscription', routeName: 'subscription' }
        : { routeKind: 'subscription_account', routeName: upstreamTarget.plannedRoute.subscriptionAccountName };
    case 'subscription':
      return { routeKind: 'subscription', routeName: 'subscription' };
    case 'passthrough':
      return { routeKind: 'passthrough', routeName: 'passthrough' };
  }
}

/**
 * Copies the client headers. For a subscription account with a live grant, it replaces Claude Code's
 * OAuth token with the access token of that grant.
 */
function buildUpstreamHeaders(clientHeaders: IncomingHttpHeaders, upstreamTarget: UpstreamTarget, requestBody: Buffer): OutgoingHttpHeaders {
  const upstreamHeaders: OutgoingHttpHeaders = {};
  for (const [headerName, headerValue] of Object.entries(clientHeaders)) {
    if (!requestHeadersNotForwarded.has(headerName) && headerValue !== undefined) upstreamHeaders[headerName] = headerValue;
  }
  if (requestBody.length > 0) upstreamHeaders['content-length'] = requestBody.length;

  if (upstreamTarget.routeKind === 'subscription_account' && upstreamTarget.plannedRoute.accessToken !== null) {
    upstreamHeaders.authorization = `Bearer ${upstreamTarget.plannedRoute.accessToken}`;
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
