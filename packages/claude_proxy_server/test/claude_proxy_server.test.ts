import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import tls from 'node:tls';
import { createClaudeProxyServer, type ClaudeProxyServer } from '../src/claude_proxy_server.ts';

interface ReceivedUpstreamRequest {
  upstreamName: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type FakeUpstreamResponder = (receivedRequest: ReceivedUpstreamRequest, upstreamResponse: ServerResponse) => void;

/** A local HTTP server that stands in for api.anthropic.com or for an API key route. */
async function startFakeUpstream(upstreamName: string, receivedRequests: ReceivedUpstreamRequest[], respond: FakeUpstreamResponder) {
  const fakeUpstreamServer = http.createServer(async (upstreamRequest, upstreamResponse) => {
    const bodyChunks: Buffer[] = [];
    for await (const bodyChunk of upstreamRequest) bodyChunks.push(bodyChunk as Buffer);
    const receivedRequest = {
      upstreamName,
      path: upstreamRequest.url ?? '',
      headers: upstreamRequest.headers,
      body: Buffer.concat(bodyChunks).toString('utf8'),
    };
    receivedRequests.push(receivedRequest);
    respond(receivedRequest, upstreamResponse);
  });
  await new Promise<void>((resolve) => fakeUpstreamServer.listen(0, '127.0.0.1', resolve));
  return { server: fakeUpstreamServer, baseUrl: `http://127.0.0.1:${(fakeUpstreamServer.address() as AddressInfo).port}` };
}

const sessionId = '11111111-2222-3333-4444-555555555555';
const claudeCodeRequestBody = {
  model: 'claude-opus-5-5',
  max_tokens: 1000,
  stream: true,
  metadata: { user_id: JSON.stringify({ device_id: 'abc', session_id: sessionId }) },
  system: [{ type: 'text', text: 'You are Claude Code.' }],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_0', content: [{ type: 'text', text: 'grep output: giraffe.ts:12' }] },
        { type: 'text', text: '<system-reminder>The `Primary working directory:` line is quoted here.</system-reminder>Find the zebra bug' },
      ],
    },
    { role: 'system', content: [{ type: 'text', text: '# Environment\n - Primary working directory: /Users/example_user/Development/example_project\n' }] },
  ],
};

function sendStreamingMessage(upstreamResponse: ServerResponse, responseText: string, extraHeaders: Record<string, string> = {}) {
  upstreamResponse.writeHead(200, { 'content-type': 'text/event-stream', ...extraHeaders });
  const streamEvents = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: responseText.slice(0, 5) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: responseText.slice(5) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"/tmp/a.txt"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 500 } },
    { type: 'message_stop' },
  ];
  for (const streamEvent of streamEvents) upstreamResponse.write(`event: ${streamEvent.type}\ndata: ${JSON.stringify(streamEvent)}\n\n`);
  upstreamResponse.end();
}

function sendJsonResponse(upstreamResponse: ServerResponse, statusCode: number, responseValue: unknown, extraHeaders: Record<string, string> = {}) {
  upstreamResponse.writeHead(statusCode, { 'content-type': 'application/json', ...extraHeaders });
  upstreamResponse.end(JSON.stringify(responseValue));
}

const weeklyLimitRejectionHeaders = {
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-7d-status': 'rejected',
  'anthropic-ratelimit-unified-7d-utilization': '1.0',
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + 86400),
};

describe('claude-proxy', () => {
  let claudeProxyDirectory: string;
  let receivedRequests: ReceivedUpstreamRequest[];
  let fakeUpstreamServers: http.Server[];
  let claudeProxyServer: ClaudeProxyServer;
  let claudeProxyBaseUrl: string;
  let subscriptionUpstreamBaseUrl: string;

  beforeEach(() => {
    claudeProxyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-test-'));
    receivedRequests = [];
    fakeUpstreamServers = [];
  });

  afterEach(async () => {
    await claudeProxyServer?.close();
    for (const fakeUpstreamServer of fakeUpstreamServers) fakeUpstreamServer.close();
    fs.rmSync(claudeProxyDirectory, { recursive: true, force: true });
  });

  async function startProxy(respondAsSubscription: FakeUpstreamResponder, apiKeyRouteResponders: FakeUpstreamResponder[]) {
    const subscriptionUpstream = await startFakeUpstream('subscription', receivedRequests, respondAsSubscription);
    fakeUpstreamServers.push(subscriptionUpstream.server);
    subscriptionUpstreamBaseUrl = subscriptionUpstream.baseUrl;
    const apiKeyRouteYaml: string[] = [];
    for (const [routeIndex, respondAsApiKeyRoute] of apiKeyRouteResponders.entries()) {
      const apiKeyUpstream = await startFakeUpstream(`key_${routeIndex + 1}`, receivedRequests, respondAsApiKeyRoute);
      fakeUpstreamServers.push(apiKeyUpstream.server);
      apiKeyRouteYaml.push(
        `  - { name: key_${routeIndex + 1}, letter: "${routeIndex + 1}", colour: "#ff0000", base_url: ${apiKeyUpstream.baseUrl}, api_key: sk-test-${routeIndex + 1} }`,
      );
    }
    fs.writeFileSync(path.join(claudeProxyDirectory, 'routes.yml'), `api_key_routes:\n${apiKeyRouteYaml.join('\n')}\n`);

    claudeProxyServer = createClaudeProxyServer({
      claudeProxyDirectory,
      anthropicBaseUrl: subscriptionUpstream.baseUrl,
      webUiDistDirectory: path.join(claudeProxyDirectory, 'no_web_ui'),
      claudeCodeProjectsDirectory: path.join(claudeProxyDirectory, 'no_projects'),
    });
    await new Promise<void>((resolve) => claudeProxyServer.httpServer.listen(0, '127.0.0.1', resolve));
    claudeProxyBaseUrl = `http://127.0.0.1:${(claudeProxyServer.httpServer.address() as AddressInfo).port}`;
  }

  function sendClaudeCodeRequest() {
    return fetch(`${claudeProxyBaseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-ant-oat-test',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
        'content-type': 'application/json',
      },
      body: JSON.stringify(claudeCodeRequestBody),
    });
  }

  async function readApi(apiPath: string) {
    return (await fetch(`${claudeProxyBaseUrl}/_proxy/api/${apiPath}`)).json() as Promise<any>;
  }

  test('forwards subscription traffic unchanged and records the assembled response', async () => {
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello zebra world', { 'anthropic-ratelimit-unified-7d-utilization': '0.5' }), []);

    const proxyResponse = await sendClaudeCodeRequest();
    const streamedText = await proxyResponse.text();

    assert.equal(proxyResponse.status, 200);
    assert.match(streamedText, /zebra world/);
    assert.equal(receivedRequests[0]!.headers.authorization, 'Bearer sk-ant-oat-test');
    assert.equal(receivedRequests[0]!.path, '/v1/messages?beta=true');

    const [requestSummary] = await readApi('proxied-requests');
    assert.equal(requestSummary.route_name, 'subscription');
    assert.equal(requestSummary.session_id, sessionId);
    assert.equal(requestSummary.project_path, '/Users/example_user/Development/example_project');
    assert.equal(requestSummary.output_tokens, 500);
    assert.equal(requestSummary.stop_reason, 'tool_use');
    assert.equal(requestSummary.user_text_preview, 'Find the zebra bug');
    // 1000 input at $4, 2000 cache reads at $0.20, 500 output at $20, per million tokens.
    assert.ok(Math.abs(requestSummary.estimated_cost_usd - (1000 * 4 + 2000 * 0.2 + 500 * 20) / 1e6) < 1e-12);

    const requestDetail = await readApi(`proxied-requests/${requestSummary.id}`);
    const assembledMessage = JSON.parse(requestDetail.response_body);
    assert.equal(assembledMessage.content[0].text, 'Hello zebra world');
    assert.deepEqual(assembledMessage.content[1].input, { file_path: '/tmp/a.txt' });
    assert.equal(JSON.parse(requestDetail.request_headers_json).authorization, 'Bearer [redacted]');
    assert.equal(JSON.parse(requestDetail.request_body).model, 'claude-opus-5-5');

    for (const searchText of ['zebra', 'giraffe', 'a.txt']) {
      assert.equal((await readApi(`proxied-requests?searchText=${searchText}`)).length, 1, `search for ${searchText}`);
    }
    assert.equal((await readApi('proxied-requests?searchText=quoted')).length, 0);
    assert.equal((await readApi('routing-status')).subscriptionWeeklyUtilization, 0.5);
  });

  test('moves to the API key when the subscription rejects a request for the weekly limit', async () => {
    await startProxy(
      (_, upstreamResponse) => sendJsonResponse(upstreamResponse, 429, { type: 'error', error: { type: 'rate_limit_error' } }, weeklyLimitRejectionHeaders),
      [(_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'From the API key')],
    );

    const proxyResponse = await sendClaudeCodeRequest();
    assert.equal(proxyResponse.status, 200);
    assert.match(await proxyResponse.text(), /the API key/);
    assert.equal(proxyResponse.headers.get('x-claude-proxy-route'), 'key_1');

    const apiKeyRequest = receivedRequests.find((receivedRequest) => receivedRequest.upstreamName === 'key_1')!;
    assert.equal(apiKeyRequest.headers['x-api-key'], 'sk-test-1');
    assert.equal(apiKeyRequest.headers.authorization, undefined);
    assert.equal(apiKeyRequest.headers['anthropic-beta'], 'claude-code-20250219,interleaved-thinking-2025-05-14');

    // The next request goes straight to the API key.
    await (await sendClaudeCodeRequest()).text();
    assert.deepEqual(receivedRequests.map((receivedRequest) => receivedRequest.upstreamName), ['subscription', 'key_1', 'key_1']);
    assert.equal((await readApi('routing-status')).activeRoute.routeName, 'key_1');
  });

  test('switches to the API key when weekly utilization reaches 98%', async () => {
    await startProxy(
      (_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Last subscription reply', { 'anthropic-ratelimit-unified-7d-utilization': '0.98' }),
      [(_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'From the API key')],
    );
    await (await sendClaudeCodeRequest()).text();
    await (await sendClaudeCodeRequest()).text();
    assert.deepEqual(receivedRequests.map((receivedRequest) => receivedRequest.upstreamName), ['subscription', 'key_1']);
  });

  test('does not switch on a 429 for the five-hour window or on a 529', async () => {
    let subscriptionStatusCode = 429;
    await startProxy(
      (_, upstreamResponse) =>
        sendJsonResponse(upstreamResponse, subscriptionStatusCode, { type: 'error', error: { type: 'rate_limit_error' } }, {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        }),
      [(_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'From the API key')],
    );
    assert.equal((await sendClaudeCodeRequest()).status, 429);
    subscriptionStatusCode = 529;
    assert.equal((await sendClaudeCodeRequest()).status, 529);
    assert.deepEqual(receivedRequests.map((receivedRequest) => receivedRequest.upstreamName), ['subscription', 'subscription']);
  });

  test('tries the next API key on a 401, then the subscription, and returns the last error', async () => {
    const respondUnauthorized: FakeUpstreamResponder = (_, upstreamResponse) =>
      sendJsonResponse(upstreamResponse, 401, { type: 'error', error: { type: 'authentication_error' } });
    await startProxy(
      (_, upstreamResponse) => sendJsonResponse(upstreamResponse, 429, { type: 'error', error: { type: 'rate_limit_error' } }, weeklyLimitRejectionHeaders),
      [respondUnauthorized, respondUnauthorized],
    );

    const firstResponse = await sendClaudeCodeRequest();
    assert.equal(firstResponse.status, 401);
    await firstResponse.text();
    assert.deepEqual(receivedRequests.map((receivedRequest) => receivedRequest.upstreamName), ['subscription', 'key_1', 'key_2']);

    // The weekly limit is now recorded, so the subscription is tried last.
    const secondResponse = await sendClaudeCodeRequest();
    assert.equal(secondResponse.status, 429);
    assert.deepEqual(receivedRequests.slice(3).map((receivedRequest) => receivedRequest.upstreamName), ['key_1', 'key_2', 'subscription']);

    const [requestSummary] = await readApi('proxied-requests');
    assert.equal(requestSummary.upstream_attempt_count, 3);
    assert.equal(requestSummary.error_type, 'rate_limit_error');
  });

  test('starts with the selected API key and obeys the forced modes', async () => {
    await startProxy(
      (_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Subscription'),
      [(_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Key 1'), (_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Key 2')],
    );
    const putRoutingSettings = (routingSettings: object) =>
      fetch(`${claudeProxyBaseUrl}/_proxy/api/routing-settings`, { method: 'PUT', body: JSON.stringify(routingSettings) }).then((apiResponse) => apiResponse.json() as Promise<any>);

    const routingStatus = await putRoutingSettings({ routingMode: 'force_api_key', selectedApiKeyRouteName: 'key_2' });
    assert.deepEqual(routingStatus.activeRoute, { routeKind: 'api_key', routeName: 'key_2', letter: '2', colour: '#ff0000' });
    await (await sendClaudeCodeRequest()).text();
    await putRoutingSettings({ routingMode: 'force_subscription' });
    await (await sendClaudeCodeRequest()).text();
    assert.deepEqual(receivedRequests.map((receivedRequest) => receivedRequest.upstreamName), ['key_2', 'subscription']);
  });

  test('rejects requests from web pages and requests addressed to another host name', async () => {
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Subscription'), []);
    const sendWithHeaders = (requestHeaders: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const proxyUrl = new URL(`${claudeProxyBaseUrl}/_proxy/api/proxied-requests`);
        http.get(proxyUrl, { headers: requestHeaders }, (proxyResponse) => {
          proxyResponse.resume();
          resolve(proxyResponse.statusCode ?? 0);
        }).on('error', reject);
      });
    const proxyHost = new URL(claudeProxyBaseUrl).host;
    assert.equal(await sendWithHeaders({ host: proxyHost }), 200);
    assert.equal(await sendWithHeaders({ host: proxyHost, origin: `http://${proxyHost}` }), 200);
    assert.equal(await sendWithHeaders({ host: proxyHost, origin: 'https://example.com' }), 403);
    assert.equal(await sendWithHeaders({ host: `rebound.example.com:${new URL(claudeProxyBaseUrl).port}` }), 403);
    assert.equal(receivedRequests.length, 0);
  });

  test('answers paths outside the Anthropic API locally and does not record them', async () => {
    await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}), []);
    for (const requestPath of ['/ideas.html', '/favicon.ico', '/.well-known/appspecific/com.chrome.devtools.json']) {
      assert.equal((await fetch(`${claudeProxyBaseUrl}${requestPath}`)).status, 404, requestPath);
    }
    assert.equal((await fetch(`${claudeProxyBaseUrl}/api/hello`, { method: 'HEAD' })).status, 200);
    assert.deepEqual(receivedRequests.map((receivedRequest) => receivedRequest.path), ['/api/hello']);
    assert.deepEqual((await readApi('proxied-requests')).map((requestSummary: { request_path: string }) => requestSummary.request_path), ['/api/hello']);
  });

  test('passes requests that carry their own API key through unchanged', async () => {
    await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, { type: 'message', content: [] }), [
      (_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Key 1'),
    ]);
    await fetch(`${claudeProxyBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'sk-client-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [] }),
    });
    assert.equal(receivedRequests[0]!.upstreamName, 'subscription');
    assert.equal(receivedRequests[0]!.headers['x-api-key'], 'sk-client-key');
    assert.equal((await readApi('proxied-requests'))[0].route_kind, 'passthrough');
  });

  describe('as an HTTPS_PROXY', () => {
    function createAnthropicApiCertificate() {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
        '-subj', '/CN=api.anthropic.com', '-addext', 'subjectAltName=DNS:api.anthropic.com',
        '-keyout', path.join(claudeProxyDirectory, 'api.anthropic.com-key.pem'),
        '-out', path.join(claudeProxyDirectory, 'api.anthropic.com.pem'),
      ], { stdio: 'ignore' });
      return fs.readFileSync(path.join(claudeProxyDirectory, 'api.anthropic.com.pem'));
    }

    /** Sends CONNECT to the proxy and resolves with the response status and, on 200, the tunnel socket. */
    function openConnectTunnel(connectTarget: string) {
      return new Promise<{ statusCode: number; tunnelSocket: net.Socket }>((resolve, reject) => {
        const proxyUrl = new URL(claudeProxyBaseUrl);
        http
          .request({ host: proxyUrl.hostname, port: proxyUrl.port, method: 'CONNECT', path: connectTarget })
          .on('connect', (connectResponse, tunnelSocket) => resolve({ statusCode: connectResponse.statusCode ?? 0, tunnelSocket }))
          .on('error', reject)
          .end();
      });
    }

    function sendHttpRequestThroughSocket(requestOptions: http.RequestOptions, connectionSocket: net.Socket, requestBody: string) {
      return new Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const clientRequest = http.request({ ...requestOptions, createConnection: () => connectionSocket }, async (clientResponse) => {
          const bodyChunks: Buffer[] = [];
          for await (const bodyChunk of clientResponse) bodyChunks.push(bodyChunk as Buffer);
          resolve({ statusCode: clientResponse.statusCode ?? 0, headers: clientResponse.headers, body: Buffer.concat(bodyChunks).toString('utf8') });
        });
        clientRequest.on('error', reject);
        clientRequest.end(requestBody);
      });
    }

    test('decrypts api.anthropic.com tunnels and routes them like ANTHROPIC_BASE_URL requests', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 429, { type: 'error' }, weeklyLimitRejectionHeaders), [
        (_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Key 1'),
      ]);
      const anthropicApiCertificate = createAnthropicApiCertificate();
      const { statusCode, tunnelSocket } = await openConnectTunnel('api.anthropic.com:443');
      assert.equal(statusCode, 200);
      const decryptedSocket = tls.connect({ socket: tunnelSocket, servername: 'api.anthropic.com', ca: anthropicApiCertificate });

      const proxiedResponse = await sendHttpRequestThroughSocket(
        {
          method: 'POST',
          path: '/v1/messages?beta=true',
          headers: { host: 'api.anthropic.com', authorization: 'Bearer sk-ant-oat-test', 'content-type': 'application/json' },
        },
        decryptedSocket,
        JSON.stringify(claudeCodeRequestBody),
      );

      assert.equal(proxiedResponse.statusCode, 200);
      assert.equal(proxiedResponse.headers['x-claude-proxy-route'], 'key_1');
      assert.deepEqual(receivedRequests.map((receivedRequest) => receivedRequest.upstreamName), ['subscription', 'key_1']);
      assert.equal(receivedRequests[0]!.headers.host, new URL(subscriptionUpstreamBaseUrl).host);
      assert.equal(receivedRequests[1]!.headers['x-api-key'], 'sk-test-1');
      assert.equal((await readApi('proxied-requests'))[0].route_name, 'key_1');
    });

    test('forwards api.anthropic.com paths outside /v1/ and /api/', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, { servers: [] }), []);
      const anthropicApiCertificate = createAnthropicApiCertificate();
      const { tunnelSocket } = await openConnectTunnel('api.anthropic.com:443');
      const decryptedSocket = tls.connect({ socket: tunnelSocket, servername: 'api.anthropic.com', ca: anthropicApiCertificate });
      const proxiedResponse = await sendHttpRequestThroughSocket(
        { method: 'GET', path: '/mcp-registry/v0/servers', headers: { host: 'api.anthropic.com' } },
        decryptedSocket,
        '',
      );
      assert.equal(proxiedResponse.statusCode, 200);
      assert.deepEqual(receivedRequests.map((receivedRequest) => receivedRequest.path), ['/mcp-registry/v0/servers']);
    });

    test('tunnels other hosts unchanged and does not record them', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, { tunnelled: true }), []);
      const subscriptionUpstreamHost = new URL(subscriptionUpstreamBaseUrl).host;
      const { statusCode, tunnelSocket } = await openConnectTunnel(subscriptionUpstreamHost);
      assert.equal(statusCode, 200);
      const tunnelledResponse = await sendHttpRequestThroughSocket(
        { method: 'GET', path: '/v1/models', headers: { host: subscriptionUpstreamHost } },
        tunnelSocket,
        '',
      );
      assert.equal(tunnelledResponse.body, '{"tunnelled":true}');
      assert.equal(tunnelledResponse.headers['x-claude-proxy-route'], undefined);
      assert.deepEqual(await readApi('proxied-requests'), []);
    });

    test('refuses api.anthropic.com tunnels while the certificate is missing', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}), []);
      const { statusCode } = await openConnectTunnel('api.anthropic.com:443');
      assert.equal(statusCode, 502);
      assert.equal(receivedRequests.length, 0);
    });
  });
});
