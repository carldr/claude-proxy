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
import { parseSubscriptionAccountUsageReport } from '../src/subscription_account_usage_monitor.ts';

interface ReceivedUpstreamRequest {
  upstreamName: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type FakeUpstreamResponder = (receivedRequest: ReceivedUpstreamRequest, upstreamResponse: ServerResponse) => void;

/** A local HTTP server that stands in for api.anthropic.com or for the OAuth token endpoint. */
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
const claudeCodeAuthorization = 'Bearer sk-ant-oat-test';
const workAuthorization = 'Bearer work-token';
const personalAuthorization = 'Bearer personal-token';
const clientProjectPath = '/Users/example_user/Development/client_project';

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

/** Returns the default request body with a different project and model. */
function buildClaudeCodeRequestBody(projectPath: string, model = 'claude-opus-5-5') {
  return {
    ...claudeCodeRequestBody,
    model,
    messages: [
      claudeCodeRequestBody.messages[0],
      { role: 'system', content: [{ type: 'text', text: `# Environment\n - Primary working directory: ${projectPath}\n` }] },
    ],
  };
}

const subscriptionAccountsYaml = `subscription_accounts:
  - { name: Work, colour: "#a1c63d" }
  - { name: Personal, colour: "#ba8048" }
project_routes:
  - { project_path_pattern: /Users/example_user/Development/client*, subscription_account: Work }
default_subscription_account: Personal
`;

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

const resetEpochSecondsInOneDay = String(Math.floor(Date.now() / 1000) + 86400);

const weeklyLimitRejectionHeaders = {
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-7d-status': 'rejected',
  'anthropic-ratelimit-unified-7d-utilization': '1.0',
  'anthropic-ratelimit-unified-7d-reset': resetEpochSecondsInOneDay,
};

const fiveHourLimitRejectionHeaders = {
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-5h-status': 'rejected',
  'anthropic-ratelimit-unified-5h-utilization': '1.0',
  'anthropic-ratelimit-unified-5h-reset': resetEpochSecondsInOneDay,
};

const fableWeeklyLimitRejectionHeaders = {
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day_fable',
  'anthropic-ratelimit-unified-reset': resetEpochSecondsInOneDay,
};

/** Answers 429 with the given rate limit headers and the account name in the error message. */
function sendRateLimitRejection(upstreamResponse: ServerResponse, subscriptionAccountName: string, rejectionHeaders: Record<string, string>) {
  sendJsonResponse(upstreamResponse, 429, { type: 'error', error: { type: 'rate_limit_error', message: subscriptionAccountName } }, rejectionHeaders);
}

function readSubscriptionAccountName(receivedRequest: ReceivedUpstreamRequest): string {
  switch (receivedRequest.headers.authorization) {
    case workAuthorization:
      return 'Work';
    case personalAuthorization:
      return 'Personal';
    case claudeCodeAuthorization:
      return 'claude_code';
    default:
      return String(receivedRequest.headers.authorization);
  }
}

test('parses five_hour, seven_day and per-model windows from the usage report', () => {
  assert.deepEqual(
    parseSubscriptionAccountUsageReport({
      five_hour: { utilization: 9, resets_at: '2026-11-01T00:00:00.000Z' },
      seven_day: { utilization: 93, resets_at: '2026-11-01T00:00:00.000Z' },
      limits: [{ scope: { model: { display_name: 'Fable' } }, percent: 59, resets_at: '2026-11-01T00:00:00.000Z' }, { scope: {}, percent: 5 }],
    }),
    [
      { usageWindowName: '5h', utilization: 0.09, resetsAt: '2026-11-01T00:00:00.000Z' },
      { usageWindowName: '7d', utilization: 0.93, resetsAt: '2026-11-01T00:00:00.000Z' },
      { usageWindowName: 'Fable', utilization: 0.59, resetsAt: '2026-11-01T00:00:00.000Z' },
    ],
  );
  assert.deepEqual(parseSubscriptionAccountUsageReport({ five_hour: null, limits: null }), []);
  assert.deepEqual(parseSubscriptionAccountUsageReport('nonsense'), []);
});

test('normalises the reset time of a usage report window to toISOString form, or to null when it is not a date', () => {
  assert.deepEqual(
    parseSubscriptionAccountUsageReport({
      five_hour: { utilization: 9, resets_at: '2026-10-26T18:00:00.123456+00:00' },
      seven_day: { utilization: 93, resets_at: 'not a date' },
    }),
    [
      { usageWindowName: '5h', utilization: 0.09, resetsAt: '2026-10-26T18:00:00.123Z' },
      { usageWindowName: '7d', utilization: 0.93, resetsAt: null },
    ],
  );
});

describe('claude-proxy', () => {
  let claudeProxyDirectory: string;
  let receivedRequests: ReceivedUpstreamRequest[];
  let fakeUpstreamServers: http.Server[];
  let claudeProxyServer: ClaudeProxyServer;
  let claudeProxyBaseUrl: string;
  let anthropicUpstreamBaseUrl: string;
  let respondAsTokenServer: FakeUpstreamResponder;

  beforeEach(() => {
    respondAsTokenServer = (_, tokenResponse) => sendJsonResponse(tokenResponse, 500, { error: 'The tests store grants that need no refresh' });
    claudeProxyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-test-'));
    receivedRequests = [];
    fakeUpstreamServers = [];
  });

  afterEach(async () => {
    await claudeProxyServer?.close();
    for (const fakeUpstreamServer of fakeUpstreamServers) fakeUpstreamServer.close();
    fs.rmSync(claudeProxyDirectory, { recursive: true, force: true });
  });

  async function startProxy(respondAsAnthropic: FakeUpstreamResponder, subscriptionAccountsYamlText = subscriptionAccountsYaml) {
    const anthropicUpstream = await startFakeUpstream('anthropic', receivedRequests, respondAsAnthropic);
    fakeUpstreamServers.push(anthropicUpstream.server);
    anthropicUpstreamBaseUrl = anthropicUpstream.baseUrl;
    const tokenServer = await startFakeUpstream('token_server', receivedRequests, (receivedRequest, tokenResponse) =>
      respondAsTokenServer(receivedRequest, tokenResponse),
    );
    fakeUpstreamServers.push(tokenServer.server);
    fs.writeFileSync(path.join(claudeProxyDirectory, 'subscription_accounts.yml'), subscriptionAccountsYamlText);

    claudeProxyServer = createClaudeProxyServer({
      claudeProxyDirectory,
      anthropicBaseUrl: anthropicUpstream.baseUrl,
      oauthEndpoints: { authorizeUrl: `${tokenServer.baseUrl}/authorize`, tokenUrl: `${tokenServer.baseUrl}/token` },
      webUiDistDirectory: path.join(claudeProxyDirectory, 'no_web_ui'),
      claudeCodeProjectsDirectory: path.join(claudeProxyDirectory, 'no_projects'),
    });
    await new Promise<void>((resolve) => claudeProxyServer.httpServer.listen(0, '127.0.0.1', resolve));
    claudeProxyBaseUrl = `http://127.0.0.1:${(claudeProxyServer.httpServer.address() as AddressInfo).port}`;
  }

  /** Stores a grant whose access token expires in 8 hours, so the proxy does not refresh it. */
  function storeTestGrant(subscriptionAccountName: string, accessToken: string) {
    claudeProxyServer.subscriptionAccountStore.writeGrant({
      subscriptionAccountName,
      accountUuid: `${subscriptionAccountName}-account-uuid`,
      organizationUuid: `${subscriptionAccountName}-organization-uuid`,
      emailAddress: null,
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      accessTokenExpiresAt: Date.now() + 8 * 60 * 60 * 1000,
      isRefreshTokenRejected: false,
    });
  }

  function storeBothTestGrants() {
    storeTestGrant('Work', 'work-token');
    storeTestGrant('Personal', 'personal-token');
  }

  function sendClaudeCodeRequest(requestBody: unknown = claudeCodeRequestBody) {
    return fetch(`${claudeProxyBaseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        authorization: claudeCodeAuthorization,
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
  }

  async function readApi(apiPath: string) {
    return (await fetch(`${claudeProxyBaseUrl}/_proxy/api/${apiPath}`)).json() as Promise<any>;
  }

  function findStatusAccount(status: any, subscriptionAccountName: string) {
    return status.subscriptionAccounts.find((statusAccount: any) => statusAccount.subscriptionAccountName === subscriptionAccountName);
  }

  function readUpstreamSubscriptionAccountNames() {
    return receivedRequests.filter((receivedRequest) => receivedRequest.upstreamName === 'anthropic').map(readSubscriptionAccountName);
  }

  test('sends a project\'s requests with its account\'s grant and records the account', async () => {
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello zebra world', { 'anthropic-ratelimit-unified-7d-utilization': '0.5' }));
    storeBothTestGrants();

    const proxyResponse = await sendClaudeCodeRequest();
    const streamedText = await proxyResponse.text();

    assert.equal(proxyResponse.status, 200);
    assert.equal(proxyResponse.headers.get('x-claude-proxy-route'), 'Personal');
    assert.match(streamedText, /zebra world/);
    assert.equal(receivedRequests[0]!.headers.authorization, personalAuthorization);
    assert.equal(receivedRequests[0]!.headers['anthropic-beta'], 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14');
    assert.equal(receivedRequests[0]!.path, '/v1/messages?beta=true');

    const [requestSummary] = await readApi('proxied-requests');
    assert.equal(requestSummary.route_kind, 'subscription_account');
    assert.equal(requestSummary.route_name, 'Personal');
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
    assert.deepEqual(claudeProxyServer.subscriptionAccountStore.readUsageWindows('Personal').usageWindows, [
      { usageWindowName: '7d', utilization: 0.5, resetsAt: null },
    ]);
  });

  test('routes a client project to Work', async () => {
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello from Work'));
    storeBothTestGrants();
    const proxyResponse = await sendClaudeCodeRequest(buildClaudeCodeRequestBody(clientProjectPath));
    await proxyResponse.text();
    assert.equal(proxyResponse.headers.get('x-claude-proxy-route'), 'Work');
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Work']);
  });

  test('routes a request without an environment block by the project it inherits', async () => {
    let upstreamRequestNumber = 0;
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello zebra world', { 'request-id': `req_${++upstreamRequestNumber}` }));
    storeBothTestGrants();
    await (await sendClaudeCodeRequest(buildClaudeCodeRequestBody(clientProjectPath))).text();
    await (await sendClaudeCodeRequest({
      ...claudeCodeRequestBody,
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.304.626; cc_prev_req=req_1;' }],
      messages: [{ role: 'user', content: 'Go on' }],
    })).text();
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Work', 'Work']);
  });

  test('gives requests without an environment block the project of the request they continue, shown as inherited', async () => {
    let upstreamRequestNumber = 0;
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello zebra world', { 'request-id': `req_${++upstreamRequestNumber}` }));
    const continuationSystem = (previousUpstreamRequestId: string) => [
      { type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.304.626; cc_prev_req=${previousUpstreamRequestId};` },
    ];
    await (await sendClaudeCodeRequest()).text();
    await (await sendClaudeCodeRequest({
      ...claudeCodeRequestBody,
      system: continuationSystem('req_1'),
      messages: [
        { role: 'user', content: 'Go on' },
        { role: 'system', content: [{ type: 'text', text: 'Hook output.\n\n# Environment update\n - Primary working directory: /Users/example_user/Development/example_project/src (was /Users/example_user/Development/example_project)' }] },
      ],
    })).text();
    await (await sendClaudeCodeRequest({ ...claudeCodeRequestBody, system: 'Summarise the session', messages: [{ role: 'user', content: 'Title?' }] })).text();
    await (await sendClaudeCodeRequest({ ...claudeCodeRequestBody, metadata: {}, system: 'No session', messages: [{ role: 'user', content: 'Hi' }] })).text();

    const projectAssignments = (await readApi('proxied-requests'))
      .reverse()
      .map((requestSummary: { project_path: string | null; is_project_path_inherited: number }) => [requestSummary.project_path, requestSummary.is_project_path_inherited]);
    assert.deepEqual(projectAssignments, [
      ['/Users/example_user/Development/example_project', 0],
      ['/Users/example_user/Development/example_project', 1],
      ['/Users/example_user/Development/example_project', 1],
      [null, 0],
    ]);
    const requestFilterOptions = await readApi('request-filter-options');
    assert.deepEqual(requestFilterOptions.projectPaths, ['/Users/example_user/Development/example_project']);
    assert.deepEqual(requestFilterOptions.models, [{ model: 'claude-opus-5-5', has_recent_traffic: 1 }]);
  });

  test('sums the cost of the filtered requests in total, over 30 days and over 24 hours', async () => {
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello zebra world'));
    await (await sendClaudeCodeRequest()).text();
    await (await sendClaudeCodeRequest()).text();
    const requestCostUsd = (1000 * 4 + 2000 * 0.2 + 500 * 20) / 1e6;

    const sessionCostTotals = await readApi(`proxied-request-cost-totals?sessionId=${sessionId}`);
    for (const costTotalName of ['total_cost_usd', 'last_30_days_cost_usd', 'last_24_hours_cost_usd']) {
      assert.ok(Math.abs(sessionCostTotals[costTotalName] - 2 * requestCostUsd) < 1e-12, costTotalName);
    }
    assert.equal((await readApi('proxied-request-cost-totals?projectPath=/elsewhere')).total_cost_usd, null);
  });

  test('fails over on a weekly rejection and stays on the other account until the reset', async () => {
    await startProxy((receivedRequest, upstreamResponse) => {
      if (receivedRequest.headers.authorization === personalAuthorization) sendRateLimitRejection(upstreamResponse, 'Personal', weeklyLimitRejectionHeaders);
      else sendStreamingMessage(upstreamResponse, 'Hello from Work');
    });
    storeBothTestGrants();

    const proxyResponse = await sendClaudeCodeRequest();
    assert.equal(proxyResponse.status, 200);
    assert.match(await proxyResponse.text(), /from Work/);
    assert.equal(proxyResponse.headers.get('x-claude-proxy-route'), 'Work');
    const [requestSummary] = await readApi('proxied-requests');
    assert.equal(requestSummary.upstream_attempt_count, 2);
    assert.equal(requestSummary.route_name, 'Work');

    await (await sendClaudeCodeRequest()).text();
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal', 'Work', 'Work']);

    const status = await readApi('subscription-account-status');
    assert.equal(findStatusAccount(status, 'Personal').blockedRateLimitWindow, 'seven_day');
    assert.equal(findStatusAccount(status, 'Work').blockedRateLimitWindow, null);
  });

  test('fails over on a five-hour rejection, in the other direction', async () => {
    await startProxy((receivedRequest, upstreamResponse) => {
      if (receivedRequest.headers.authorization === workAuthorization) sendRateLimitRejection(upstreamResponse, 'Work', fiveHourLimitRejectionHeaders);
      else sendStreamingMessage(upstreamResponse, 'Hello from Personal');
    });
    storeBothTestGrants();

    const proxyResponse = await sendClaudeCodeRequest(buildClaudeCodeRequestBody(clientProjectPath));
    assert.equal(proxyResponse.status, 200);
    assert.match(await proxyResponse.text(), /from Personal/);
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Work', 'Personal']);
  });

  describe('failover utilization', () => {
    function respondFromPersonalAtUtilization(utilizationHeaders: Record<string, string>): FakeUpstreamResponder {
      return (receivedRequest, upstreamResponse) => {
        if (receivedRequest.headers.authorization === personalAuthorization) sendStreamingMessage(upstreamResponse, 'Hello from Personal', utilizationHeaders);
        else sendStreamingMessage(upstreamResponse, 'Hello from Work');
      };
    }

    test('routes away from an account at the failover utilization, before any rejection', async () => {
      await startProxy(respondFromPersonalAtUtilization({ 'anthropic-ratelimit-unified-7d-utilization': '0.98' }));
      storeBothTestGrants();
      await (await sendClaudeCodeRequest()).text();
      await (await sendClaudeCodeRequest()).text();
      assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal', 'Work']);
    });

    test('routes away on the 5-hour window too', async () => {
      await startProxy(
        respondFromPersonalAtUtilization({ 'anthropic-ratelimit-unified-5h-utilization': '0.99', 'anthropic-ratelimit-unified-7d-utilization': '0.10' }),
      );
      storeBothTestGrants();
      await (await sendClaudeCodeRequest()).text();
      await (await sendClaudeCodeRequest()).text();
      assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal', 'Work']);
    });

    test('keeps using an account below the failover utilization', async () => {
      await startProxy(respondFromPersonalAtUtilization({ 'anthropic-ratelimit-unified-7d-utilization': '0.97' }));
      storeBothTestGrants();
      await (await sendClaudeCodeRequest()).text();
      await (await sendClaudeCodeRequest()).text();
      assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal', 'Personal']);
    });

    test('returns to the account when its utilization falls below the threshold', async () => {
      await startProxy((receivedRequest, upstreamResponse) => {
        if (receivedRequest.path === '/api/oauth/usage') {
          sendJsonResponse(upstreamResponse, 200, { five_hour: { utilization: 50, resets_at: '2026-11-01T00:00:00.000Z' }, seven_day: { utilization: 50, resets_at: '2026-11-01T00:00:00.000Z' } });
        } else if (receivedRequest.headers.authorization === personalAuthorization) {
          sendStreamingMessage(upstreamResponse, 'Hello from Personal', { 'anthropic-ratelimit-unified-7d-utilization': '0.98' });
        } else sendStreamingMessage(upstreamResponse, 'Hello from Work');
      });
      storeBothTestGrants();
      await (await sendClaudeCodeRequest()).text();
      await (await sendClaudeCodeRequest()).text();
      await claudeProxyServer.subscriptionAccountUsageMonitor.checkAllSubscriptionAccountUsage();
      await (await sendClaudeCodeRequest()).text();
      assert.deepEqual(
        receivedRequests.filter((receivedRequest) => receivedRequest.path.startsWith('/v1/messages')).map(readSubscriptionAccountName),
        ['Personal', 'Work', 'Personal'],
      );
    });

    test('ignores a usage window whose reset time has passed', async () => {
      await startProxy(respondFromPersonalAtUtilization({}));
      storeBothTestGrants();
      claudeProxyServer.subscriptionAccountStore.mergeUsageWindows(
        'Personal',
        [{ usageWindowName: '5h', utilization: 0.99, resetsAt: new Date(Date.now() - 60_000).toISOString() }],
        new Date().toISOString(),
      );
      await (await sendClaudeCodeRequest()).text();
      assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal']);
      const status = await readApi('subscription-account-status');
      assert.equal(status.subscriptionAccounts.find((statusAccount: any) => statusAccount.subscriptionAccountName === 'Personal').isBlocked, false);
    });

    test('returns the project\'s own account when every account is above the failover utilization', async () => {
      await startProxy(respondFromPersonalAtUtilization({}));
      storeBothTestGrants();
      const resetsAt = new Date(Date.now() + 86400_000).toISOString();
      for (const subscriptionAccountName of ['Work', 'Personal']) {
        claudeProxyServer.subscriptionAccountStore.mergeUsageWindows(
          subscriptionAccountName,
          [{ usageWindowName: '7d', utilization: 0.99, resetsAt }],
          new Date().toISOString(),
        );
      }
      await (await sendClaudeCodeRequest()).text();
      assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal']);
      assert.equal(receivedRequests.filter((receivedRequest) => receivedRequest.upstreamName === 'anthropic').length, 1);
      assert.equal(receivedRequests.find((receivedRequest) => receivedRequest.upstreamName === 'anthropic')!.headers.authorization, personalAuthorization);
    });

    test('shows an account at the threshold as blocked in the status', async () => {
      await startProxy(respondFromPersonalAtUtilization({ 'anthropic-ratelimit-unified-7d-utilization': '0.98' }));
      storeBothTestGrants();
      await (await sendClaudeCodeRequest()).text();
      const status = await readApi('subscription-account-status');
      const personalStatus = status.subscriptionAccounts.find((statusAccount: any) => statusAccount.subscriptionAccountName === 'Personal');
      assert.equal(personalStatus.isBlocked, true);
      assert.equal(personalStatus.blockedUntil, null);
    });
  });

  test('blocks only the rejected model on a per-model weekly rejection', async () => {
    await startProxy((receivedRequest, upstreamResponse) => {
      const requestModel = JSON.parse(receivedRequest.body).model;
      if (receivedRequest.headers.authorization === personalAuthorization && requestModel === 'claude-fable-5-1') {
        sendRateLimitRejection(upstreamResponse, 'Personal', fableWeeklyLimitRejectionHeaders);
      } else {
        sendStreamingMessage(upstreamResponse, 'Hello');
      }
    });
    storeBothTestGrants();
    const defaultProjectPath = '/Users/example_user/Development/example_project';

    await (await sendClaudeCodeRequest(buildClaudeCodeRequestBody(defaultProjectPath, 'claude-fable-5-1'))).text();
    await (await sendClaudeCodeRequest(buildClaudeCodeRequestBody(defaultProjectPath, 'claude-opus-5-5'))).text();
    await (await sendClaudeCodeRequest(buildClaudeCodeRequestBody(defaultProjectPath, 'claude-fable-5-1'))).text();
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal', 'Work', 'Personal', 'Work']);
  });

  test('returns the project\'s own rejection when every account is blocked', async () => {
    await startProxy((receivedRequest, upstreamResponse) =>
      sendRateLimitRejection(upstreamResponse, readSubscriptionAccountName(receivedRequest), weeklyLimitRejectionHeaders),
    );
    storeBothTestGrants();

    const firstResponse = await sendClaudeCodeRequest();
    assert.equal(firstResponse.status, 429);
    assert.equal(firstResponse.headers.get('x-claude-proxy-route'), 'Work');
    assert.equal((await firstResponse.json() as any).error.message, 'Work');
    assert.equal((await readApi('proxied-requests'))[0].upstream_attempt_count, 2);

    const secondResponse = await sendClaudeCodeRequest();
    assert.equal(secondResponse.status, 429);
    assert.equal((await secondResponse.json() as any).error.message, 'Personal');
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal', 'Work', 'Personal']);
    const [secondRequestSummary] = await readApi('proxied-requests');
    assert.equal(secondRequestSummary.upstream_attempt_count, 1);
    assert.equal(secondRequestSummary.route_name, 'Personal');
    assert.equal(secondRequestSummary.error_type, 'rate_limit_error');
  });

  test('forwards a 401, a 529 and a network error without failover', async () => {
    let upstreamRequestNumber = 0;
    await startProxy((_, upstreamResponse) => {
      upstreamRequestNumber++;
      if (upstreamRequestNumber === 1) sendJsonResponse(upstreamResponse, 401, { type: 'error', error: { type: 'authentication_error' } });
      else if (upstreamRequestNumber === 2) sendJsonResponse(upstreamResponse, 529, { type: 'error', error: { type: 'overloaded_error' } });
      else upstreamResponse.socket!.destroy();
    });
    storeBothTestGrants();

    const statusCodes: number[] = [];
    for (let requestNumber = 0; requestNumber < 3; requestNumber++) {
      const proxyResponse = await sendClaudeCodeRequest();
      await proxyResponse.text();
      statusCodes.push(proxyResponse.status);
    }
    assert.deepEqual(statusCodes, [401, 529, 502]);
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal', 'Personal', 'Personal']);
    assert.deepEqual((await readApi('proxied-requests')).map((requestSummary: { upstream_attempt_count: number }) => requestSummary.upstream_attempt_count), [1, 1, 1]);
  });

  test('sends Claude Code\'s own token for an account without a grant, and never fails over to it', async () => {
    await startProxy((receivedRequest, upstreamResponse) => {
      if (receivedRequest.headers.authorization === workAuthorization) sendRateLimitRejection(upstreamResponse, 'Work', weeklyLimitRejectionHeaders);
      else sendStreamingMessage(upstreamResponse, 'Hello', { 'anthropic-ratelimit-unified-7d-utilization': '0.5' });
    });
    storeTestGrant('Work', 'work-token');

    const defaultProjectResponse = await sendClaudeCodeRequest();
    await defaultProjectResponse.text();
    assert.equal(defaultProjectResponse.headers.get('x-claude-proxy-route'), 'subscription');
    const [defaultProjectRequestSummary] = await readApi('proxied-requests');
    assert.equal(defaultProjectRequestSummary.route_kind, 'subscription');
    assert.equal(defaultProjectRequestSummary.route_name, 'subscription');
    // Claude Code's token can belong to another account, so its usage is not stored under Personal.
    assert.deepEqual(claudeProxyServer.subscriptionAccountStore.readUsageWindows('Personal').usageWindows, []);
    const clientProjectResponse = await sendClaudeCodeRequest(buildClaudeCodeRequestBody(clientProjectPath));
    await clientProjectResponse.text();
    assert.equal(clientProjectResponse.status, 429);
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['claude_code', 'Work']);
  });

  test('forwards a request with Claude Code\'s own token when route planning throws', async () => {
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello'));
    storeBothTestGrants();
    claudeProxyServer.subscriptionAccountRouter.planRoutes = async () => {
      throw new Error('database is locked');
    };
    const response = await sendClaudeCodeRequest();
    await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['claude_code']);
  });

  test('allows only the user to read the proxy directory and the request database', async () => {
    fs.chmodSync(claudeProxyDirectory, 0o755);
    fs.writeFileSync(path.join(claudeProxyDirectory, 'requests.sqlite'), '');
    fs.chmodSync(path.join(claudeProxyDirectory, 'requests.sqlite'), 0o644);
    await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));

    assert.equal(fs.statSync(claudeProxyDirectory).mode & 0o777, 0o700);
    const requestDatabaseFileNames = fs.readdirSync(claudeProxyDirectory).filter((fileName) => fileName.startsWith('requests.sqlite'));
    assert.ok(requestDatabaseFileNames.length > 0);
    for (const requestDatabaseFileName of requestDatabaseFileNames) {
      assert.equal(fs.statSync(path.join(claudeProxyDirectory, requestDatabaseFileName)).mode & 0o777, 0o600, requestDatabaseFileName);
    }
  });

  test('does not send a request upstream when the client closes it while the routes are planned', async () => {
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello'));
    storeBothTestGrants();
    const { subscriptionAccountRouter } = claudeProxyServer;
    const planRoutes = subscriptionAccountRouter.planRoutes.bind(subscriptionAccountRouter);
    const planningStarted = Promise.withResolvers<void>();
    const planningGate = Promise.withResolvers<void>();
    subscriptionAccountRouter.planRoutes = async (...planRoutesArguments) => {
      planningStarted.resolve();
      await planningGate.promise;
      return planRoutes(...planRoutesArguments);
    };
    const clientAbortController = new AbortController();
    const responsePromise = fetch(`${claudeProxyBaseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { authorization: claudeCodeAuthorization, 'content-type': 'application/json' },
      body: JSON.stringify(claudeCodeRequestBody),
      signal: clientAbortController.signal,
    });
    await planningStarted.promise;
    clientAbortController.abort();
    await assert.rejects(responsePromise);
    await new Promise((resolve) => setTimeout(resolve, 100));
    planningGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), []);
  });

  test('forwards a request with Claude Code\'s own token when the project lookup throws', async () => {
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello'));
    storeBothTestGrants();
    claudeProxyServer.requestDatabase.findProjectPath = () => {
      throw new Error('database is locked');
    };
    const response = await sendClaudeCodeRequest();
    await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['claude_code']);
  });

  test('forwards requests unchanged while subscription_accounts.yml has an error', async () => {
    await startProxy(
      (_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello'),
      subscriptionAccountsYaml.replace('subscription_account: Work }', 'subscription_account: Unknown }'),
    );
    storeBothTestGrants();
    await (await sendClaudeCodeRequest()).text();
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['claude_code']);
    assert.equal((await readApi('proxied-requests'))[0].route_kind, 'subscription');
  });

  test('keeps routing by the last valid subscription_accounts.yml after an edit breaks it', async () => {
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello'));
    storeBothTestGrants();
    await (await sendClaudeCodeRequest()).text();
    const subscriptionAccountsYamlPath = path.join(claudeProxyDirectory, 'subscription_accounts.yml');
    fs.writeFileSync(subscriptionAccountsYamlPath, subscriptionAccountsYaml.replace('subscription_account: Work }', 'subscription_account: Unknown }'));
    const editTime = new Date(Date.now() + 60_000);
    fs.utimesSync(subscriptionAccountsYamlPath, editTime, editTime);
    await (await sendClaudeCodeRequest()).text();
    assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal', 'Personal']);
    assert.ok((await readApi('subscription-account-status')).configErrors.length > 0);
  });

  test('leaves every non-message path untouched', async () => {
    await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
    storeBothTestGrants();
    for (const requestPath of ['/v1/code/sessions/cse_1/worker/heartbeat', '/api/oauth/profile']) {
      const proxyResponse = await fetch(`${claudeProxyBaseUrl}${requestPath}`, { method: 'POST', headers: { authorization: claudeCodeAuthorization } });
      await proxyResponse.text();
      assert.equal(proxyResponse.headers.get('x-claude-proxy-route'), 'subscription', requestPath);
    }
    assert.deepEqual(receivedRequests.map((receivedRequest) => receivedRequest.path), ['/v1/code/sessions/cse_1/worker/heartbeat', '/api/oauth/profile']);
    for (const receivedRequest of receivedRequests) assert.equal(receivedRequest.headers.authorization, claudeCodeAuthorization);
  });

  test('rejects requests from web pages and requests addressed to another host name', async () => {
    await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello'));
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
    await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
    for (const requestPath of ['/ideas.html', '/favicon.ico', '/.well-known/appspecific/com.chrome.devtools.json']) {
      assert.equal((await fetch(`${claudeProxyBaseUrl}${requestPath}`)).status, 404, requestPath);
    }
    assert.equal((await fetch(`${claudeProxyBaseUrl}/api/hello`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${claudeProxyBaseUrl}/api/oauth/account/settings`)).status, 200);
    assert.deepEqual(receivedRequests.map((receivedRequest) => receivedRequest.path), ['/api/hello', '/api/oauth/account/settings']);
    assert.deepEqual((await readApi('proxied-requests')).map((requestSummary: { request_path: string }) => requestSummary.request_path), ['/api/hello']);
  });

  test('passes requests that carry their own API key through unchanged', async () => {
    await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, { type: 'message', content: [] }));
    storeBothTestGrants();
    await fetch(`${claudeProxyBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'sk-client-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [] }),
    });
    assert.equal(receivedRequests[0]!.headers['x-api-key'], 'sk-client-key');
    assert.equal(receivedRequests[0]!.headers.authorization, undefined);
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
      await startProxy((receivedRequest, upstreamResponse) => {
        if (receivedRequest.headers.authorization === personalAuthorization) sendRateLimitRejection(upstreamResponse, 'Personal', weeklyLimitRejectionHeaders);
        else sendStreamingMessage(upstreamResponse, 'Hello from Work');
      });
      storeBothTestGrants();
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
      assert.equal(proxiedResponse.headers['x-claude-proxy-route'], 'Work');
      assert.deepEqual(readUpstreamSubscriptionAccountNames(), ['Personal', 'Work']);
      assert.equal(receivedRequests[0]!.headers.host, new URL(anthropicUpstreamBaseUrl).host);
      assert.equal((await readApi('proxied-requests'))[0].route_name, 'Work');
    });

    test('forwards api.anthropic.com paths outside /v1/ and /api/, and does not record them', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, { servers: [] }));
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
      assert.deepEqual(await readApi('proxied-requests'), []);
    });

    test('tunnels other hosts unchanged and does not record them', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, { tunnelled: true }));
      const anthropicUpstreamHost = new URL(anthropicUpstreamBaseUrl).host;
      const { statusCode, tunnelSocket } = await openConnectTunnel(anthropicUpstreamHost);
      assert.equal(statusCode, 200);
      const tunnelledResponse = await sendHttpRequestThroughSocket(
        { method: 'GET', path: '/v1/models', headers: { host: anthropicUpstreamHost } },
        tunnelSocket,
        '',
      );
      assert.equal(tunnelledResponse.body, '{"tunnelled":true}');
      assert.equal(tunnelledResponse.headers['x-claude-proxy-route'], undefined);
      assert.deepEqual(await readApi('proxied-requests'), []);
    });

    test('keeps running when a client resets its tunnel', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      const resetTunnel = async (connectTarget: string) => (await openConnectTunnel(connectTarget)).tunnelSocket.resetAndDestroy();
      await resetTunnel('api.anthropic.com:443');
      createAnthropicApiCertificate();
      await resetTunnel('api.anthropic.com:443');
      await resetTunnel(new URL(anthropicUpstreamBaseUrl).host);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(await readApi('proxied-requests'), []);
    });

    test('refuses api.anthropic.com tunnels while the certificate is missing', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      const { statusCode } = await openConnectTunnel('api.anthropic.com:443');
      assert.equal(statusCode, 502);
      assert.equal(receivedRequests.length, 0);
    });
  });
  describe('subscription account status', () => {
    const usageResetsAt = '2026-11-01T00:00:00.000Z';

    /** Answers GET /api/oauth/usage with the weekly percentage given for the account that owns the token. */
    function respondWithWeeklyUsage(weeklyPercentByAuthorization: Record<string, number>): FakeUpstreamResponder {
      return (receivedRequest, upstreamResponse) => {
        const weeklyPercent = weeklyPercentByAuthorization[String(receivedRequest.headers.authorization)];
        if (receivedRequest.path !== '/api/oauth/usage' || weeklyPercent === undefined) return sendJsonResponse(upstreamResponse, 404, {});
        sendJsonResponse(upstreamResponse, 200, {
          five_hour: { utilization: 9, resets_at: usageResetsAt },
          seven_day: { utilization: weeklyPercent, resets_at: usageResetsAt },
        });
      };
    }

    test('polls each logged-in account with its own grant', async () => {
      await startProxy(respondWithWeeklyUsage({ [workAuthorization]: 93, [personalAuthorization]: 40 }));
      storeBothTestGrants();

      const usageCheckResponse = await fetch(`${claudeProxyBaseUrl}/_proxy/api/subscription-account-usage-check`, { method: 'POST' });
      const status = await usageCheckResponse.json();

      assert.deepEqual(status.usageCheckErrors, []);
      assert.deepEqual(
        receivedRequests.filter((receivedRequest) => receivedRequest.path === '/api/oauth/usage').map(readSubscriptionAccountName).sort(),
        ['Personal', 'Work'],
      );
      const workRequest = receivedRequests.find((receivedRequest) => readSubscriptionAccountName(receivedRequest) === 'Work')!;
      assert.equal(workRequest.headers['anthropic-beta'], 'oauth-2025-04-20');
      const readStatus = await readApi('subscription-account-status');
      assert.equal(findStatusAccount(readStatus, 'Work').weeklyUtilization, 0.93);
      assert.equal(findStatusAccount(readStatus, 'Personal').weeklyUtilization, 0.4);
      assert.equal(findStatusAccount(readStatus, 'Work').colour, '#a1c63d');
      assert.ok(findStatusAccount(readStatus, 'Work').usageCheckedAt);
    });

    test('clears a whole-account block when the usage poll shows room again', async () => {
      await startProxy(respondWithWeeklyUsage({ [personalAuthorization]: 40 }));
      storeTestGrant('Personal', 'personal-token');
      claudeProxyServer.subscriptionAccountStore.writeLimitBlock({
        subscriptionAccountName: 'Personal',
        blockedModel: '',
        rateLimitWindow: 'seven_day',
        blockedUntil: new Date(Date.now() + 86400_000).toISOString(),
      });
      const blockedStatus = findStatusAccount(await readApi('subscription-account-status'), 'Personal');
      assert.equal(blockedStatus.isBlocked, true);
      assert.ok(blockedStatus.blockedUntil);

      assert.deepEqual(await claudeProxyServer.subscriptionAccountUsageMonitor.checkAllSubscriptionAccountUsage(), []);

      const clearedStatus = findStatusAccount(await readApi('subscription-account-status'), 'Personal');
      assert.equal(clearedStatus.isBlocked, false);
      assert.equal(clearedStatus.blockedUntil, null);
    });

    test('keeps a whole-account block while the usage poll shows no room', async () => {
      await startProxy(respondWithWeeklyUsage({ [personalAuthorization]: 100 }));
      storeTestGrant('Personal', 'personal-token');
      claudeProxyServer.subscriptionAccountStore.writeLimitBlock({
        subscriptionAccountName: 'Personal',
        blockedModel: '',
        rateLimitWindow: 'seven_day',
        blockedUntil: new Date(Date.now() + 86400_000).toISOString(),
      });
      await claudeProxyServer.subscriptionAccountUsageMonitor.checkAllSubscriptionAccountUsage();
      assert.equal(findStatusAccount(await readApi('subscription-account-status'), 'Personal').isBlocked, true);
    });

    test('keeps a weekly whole-account block while the poll shows the weekly window full and the 5-hour window free', async () => {
      await startProxy(respondWithWeeklyUsage({ [personalAuthorization]: 100 }));
      storeTestGrant('Personal', 'personal-token');
      const store = claudeProxyServer.subscriptionAccountStore;
      store.writeLimitBlock({ subscriptionAccountName: 'Personal', blockedModel: '', rateLimitWindow: 'seven_day', blockedUntil: new Date(Date.now() + 3 * 86400_000).toISOString() });
      store.writeLimitBlock({ subscriptionAccountName: 'Personal', blockedModel: '', rateLimitWindow: 'five_hour', blockedUntil: new Date(Date.now() + 2 * 3600_000).toISOString() });
      await claudeProxyServer.subscriptionAccountUsageMonitor.checkAllSubscriptionAccountUsage();
      assert.equal(findStatusAccount(await readApi('subscription-account-status'), 'Personal').isBlocked, true);
    });

    test('reports login_required for an account without a grant or with a rejected refresh token', async () => {
      await startProxy(respondWithWeeklyUsage({ [workAuthorization]: 10, [personalAuthorization]: 10 }));
      storeTestGrant('Personal', 'personal-token');
      claudeProxyServer.subscriptionAccountStore.writeGrant({
        ...claudeProxyServer.subscriptionAccountStore.readGrant('Personal')!,
        isRefreshTokenRejected: true,
      });

      const loginRequiredErrors = await claudeProxyServer.subscriptionAccountUsageMonitor.checkAllSubscriptionAccountUsage();

      assert.deepEqual(loginRequiredErrors, []);
      assert.equal(receivedRequests.filter((receivedRequest) => receivedRequest.path === '/api/oauth/usage').length, 0);
      const status = await readApi('subscription-account-status');
      assert.equal(findStatusAccount(status, 'Work').loginState, 'login_required');
      assert.equal(findStatusAccount(status, 'Personal').loginState, 'login_required');
      storeTestGrant('Work', 'work-token');
      assert.equal(findStatusAccount(await readApi('subscription-account-status'), 'Work').loginState, 'logged_in');
    });

    test('reports one error for each account whose usage poll fails, and polls the others', async () => {
      await startProxy(respondWithWeeklyUsage({ [personalAuthorization]: 40 }));
      storeBothTestGrants();
      const usageCheckErrors = await claudeProxyServer.subscriptionAccountUsageMonitor.checkAllSubscriptionAccountUsage();
      assert.equal(usageCheckErrors.length, 1);
      assert.match(usageCheckErrors[0]!, /^Work: .*404/);
      assert.equal(findStatusAccount(await readApi('subscription-account-status'), 'Personal').weeklyUtilization, 0.4);
    });

    test('updates usage from the headers of every routed response', async () => {
      await startProxy((_, upstreamResponse) => sendStreamingMessage(upstreamResponse, 'Hello', { 'anthropic-ratelimit-unified-7d-utilization': '0.5' }));
      storeBothTestGrants();
      await (await sendClaudeCodeRequest()).text();
      assert.equal(findStatusAccount(await readApi('subscription-account-status'), 'Personal').weeklyUtilization, 0.5);
    });

    test('reports the failover utilization of subscription_accounts.yml', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}), `${subscriptionAccountsYaml}failover_utilization: 0.9\n`);
      assert.equal((await readApi('subscription-account-status')).failoverUtilization, 0.9);
    });

    test('lists the configuration errors of subscription_accounts.yml', async () => {
      await startProxy(
        (_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}),
        subscriptionAccountsYaml.replace('subscription_account: Work }', 'subscription_account: Unknown }'),
      );
      const status = await readApi('subscription-account-status');
      assert.ok(status.configErrors.length > 0);
      assert.match(status.configErrors[0], /Unknown/);
    });
  });

  describe('subscription account login', () => {
    function answerLoginWithIdentity(accountUuid: string, organizationUuid: string, emailAddress: string) {
      respondAsTokenServer = (_, tokenResponse) =>
        sendJsonResponse(tokenResponse, 200, {
          access_token: 'login-access-token',
          refresh_token: 'login-refresh-token',
          expires_in: 28800,
          account: { uuid: accountUuid, email_address: emailAddress },
          organization: { uuid: organizationUuid },
        });
    }

    async function startLogin(subscriptionAccountName: string) {
      const loginResponse = await fetch(`${claudeProxyBaseUrl}/_proxy/api/subscription-accounts/${subscriptionAccountName}/login`, { method: 'POST' });
      return { loginResponse, loginBody: (await loginResponse.json()) as any };
    }

    function callCallback(callbackQuery: string) {
      return fetch(`${claudeProxyBaseUrl}/callback?${callbackQuery}`, { redirect: 'manual' });
    }

    test('logs in an account through the loopback callback', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      answerLoginWithIdentity('person-account-uuid', 'person-organization-uuid', 'person@example.com');

      const { loginResponse, loginBody } = await startLogin('Personal');
      assert.equal(loginResponse.status, 200);
      const authorizeUrl = new URL(loginBody.authorizeUrl);
      assert.equal(authorizeUrl.searchParams.get('redirect_uri'), `http://localhost:${new URL(claudeProxyBaseUrl).port}/callback`);
      const callbackResponse = await callCallback(`code=the-code&state=${authorizeUrl.searchParams.get('state')}`);

      assert.equal(callbackResponse.status, 302);
      assert.equal(callbackResponse.headers.get('location'), '/_proxy/');
      const storedGrant = claudeProxyServer.subscriptionAccountStore.readGrant('Personal');
      assert.equal(storedGrant?.accessToken, 'login-access-token');
      assert.equal(storedGrant?.refreshToken, 'login-refresh-token');
      const personalStatus = findStatusAccount(await readApi('subscription-account-status'), 'Personal');
      assert.equal(personalStatus.loginState, 'logged_in');
      assert.equal(personalStatus.emailAddress, 'person@example.com');
    });

    test('replaces the grant when the same account logs in again', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      storeTestGrant('Personal', 'personal-token');
      answerLoginWithIdentity('Personal-account-uuid', 'Personal-organization-uuid', 'person@example.com');
      const { loginBody } = await startLogin('Personal');
      const callbackResponse = await callCallback(`code=the-code&state=${new URL(loginBody.authorizeUrl).searchParams.get('state')}`);
      assert.equal(callbackResponse.status, 302);
      assert.equal(claudeProxyServer.subscriptionAccountStore.readGrant('Personal')?.accessToken, 'login-access-token');
    });

    test('clears the usage windows and limit blocks of a name when another Claude account logs in to it', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      const { subscriptionAccountStore } = claudeProxyServer;
      storeTestGrant('Personal', 'personal-token');
      subscriptionAccountStore.mergeUsageWindows('Personal', [{ usageWindowName: '7d', utilization: 0.9, resetsAt: null }], new Date().toISOString());
      subscriptionAccountStore.writeLimitBlock({
        subscriptionAccountName: 'Personal',
        blockedModel: '',
        rateLimitWindow: 'seven_day',
        blockedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      answerLoginWithIdentity('other-account-uuid', 'other-organization-uuid', 'other@example.com');
      const { loginBody } = await startLogin('Personal');
      const callbackResponse = await callCallback(`code=the-code&state=${new URL(loginBody.authorizeUrl).searchParams.get('state')}`);

      assert.equal(callbackResponse.status, 302);
      assert.equal(subscriptionAccountStore.readGrant('Personal')?.accountUuid, 'other-account-uuid');
      assert.deepEqual(subscriptionAccountStore.readUsageWindows('Personal').usageWindows, []);
      assert.deepEqual(subscriptionAccountStore.readActiveLimitBlocks(new Date()), []);
    });

    test('keeps the usage windows of a name when the same Claude account logs in to it again', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      const { subscriptionAccountStore } = claudeProxyServer;
      storeTestGrant('Personal', 'personal-token');
      subscriptionAccountStore.mergeUsageWindows('Personal', [{ usageWindowName: '7d', utilization: 0.9, resetsAt: null }], new Date().toISOString());
      answerLoginWithIdentity('Personal-account-uuid', 'Personal-organization-uuid', 'person@example.com');
      const { loginBody } = await startLogin('Personal');
      await callCallback(`code=the-code&state=${new URL(loginBody.authorizeUrl).searchParams.get('state')}`);

      assert.equal(subscriptionAccountStore.readUsageWindows('Personal').usageWindows.length, 1);
    });

    test('refuses a login whose account is stored under another name', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      storeTestGrant('Work', 'work-token');
      respondAsTokenServer = (_, tokenResponse) =>
        sendJsonResponse(tokenResponse, 200, {
          access_token: 'login-access-token',
          refresh_token: 'login-refresh-token',
          expires_in: 28800,
          account: { uuid: 'Work-account-uuid', email_address: 'work@example.com' },
          organization: { uuid: 'Work-organization-uuid' },
        });
      const { loginBody } = await startLogin('Personal');
      const callbackResponse = await callCallback(`code=the-code&state=${new URL(loginBody.authorizeUrl).searchParams.get('state')}`);

      assert.equal(callbackResponse.status, 400);
      assert.match(await callbackResponse.text(), /already logged in as Work/);
      assert.equal(claudeProxyServer.subscriptionAccountStore.readGrant('Personal'), null);
      assert.equal(claudeProxyServer.subscriptionAccountStore.readGrant('Work')?.accessToken, 'work-token');
    });

    test('accepts a login whose account is stored under a name that is no longer configured, and deletes that name', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      const { subscriptionAccountStore } = claudeProxyServer;
      storeTestGrant('OldName', 'old-name-token');
      subscriptionAccountStore.mergeUsageWindows('OldName', [{ usageWindowName: '7d', utilization: 0.5, resetsAt: null }], new Date().toISOString());
      subscriptionAccountStore.writeLimitBlock({
        subscriptionAccountName: 'OldName',
        blockedModel: '',
        rateLimitWindow: 'seven_day',
        blockedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      answerLoginWithIdentity('OldName-account-uuid', 'OldName-organization-uuid', 'old@example.com');
      const { loginBody } = await startLogin('Personal');
      const callbackResponse = await callCallback(`code=the-code&state=${new URL(loginBody.authorizeUrl).searchParams.get('state')}`);

      assert.equal(callbackResponse.status, 302);
      assert.equal(subscriptionAccountStore.readGrant('Personal')?.accessToken, 'login-access-token');
      assert.equal(subscriptionAccountStore.readGrant('OldName'), null);
      assert.deepEqual(subscriptionAccountStore.readUsageWindows('OldName').usageWindows, []);
      assert.deepEqual(
        subscriptionAccountStore.readActiveLimitBlocks(new Date()).filter((limitBlock) => limitBlock.subscriptionAccountName === 'OldName'),
        [],
      );
    });

    test('rejects a callback with an unknown state', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      answerLoginWithIdentity('person-account-uuid', 'person-organization-uuid', 'person@example.com');
      const callbackResponse = await callCallback('code=the-code&state=unknown-state');
      assert.equal(callbackResponse.status, 400);
      assert.match(await callbackResponse.text(), /state/);
      assert.equal(claudeProxyServer.subscriptionAccountStore.readGrant('Personal'), null);
      assert.equal(receivedRequests.filter((receivedRequest) => receivedRequest.upstreamName === 'token_server').length, 0);
    });

    test('accepts a state once only', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      answerLoginWithIdentity('person-account-uuid', 'person-organization-uuid', 'person@example.com');
      const { loginBody } = await startLogin('Personal');
      const callbackQuery = `code=the-code&state=${new URL(loginBody.authorizeUrl).searchParams.get('state')}`;
      assert.equal((await callCallback(callbackQuery)).status, 302);
      assert.equal((await callCallback(callbackQuery)).status, 400);
    });

    test('answers 400 with the token endpoint error when the code exchange fails', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      respondAsTokenServer = (_, tokenResponse) => sendJsonResponse(tokenResponse, 400, { error: 'invalid_grant' });
      const { loginBody } = await startLogin('Personal');
      const callbackResponse = await callCallback(`code=the-code&state=${new URL(loginBody.authorizeUrl).searchParams.get('state')}`);
      assert.equal(callbackResponse.status, 400);
      assert.match(await callbackResponse.text(), /invalid_grant/);
      assert.equal(claudeProxyServer.subscriptionAccountStore.readGrant('Personal'), null);
    });

    test('does not show any part of a successful token response that is not JSON', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      respondAsTokenServer = (_, tokenResponse) => {
        tokenResponse.writeHead(200, { 'content-type': 'text/plain' });
        tokenResponse.end('not json sk-ant-oat-secret');
      };
      const { loginBody } = await startLogin('Personal');
      const callbackResponse = await callCallback(`code=the-code&state=${new URL(loginBody.authorizeUrl).searchParams.get('state')}`);
      assert.equal(callbackResponse.status, 400);
      assert.doesNotMatch(await callbackResponse.text(), /sk-ant-oat-secret/);
    });

    test('rejects a callback that carries an error instead of a code', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      const { loginBody } = await startLogin('Personal');
      const callbackResponse = await callCallback(`error=access_denied&state=${new URL(loginBody.authorizeUrl).searchParams.get('state')}`);
      assert.equal(callbackResponse.status, 400);
      assert.match(await callbackResponse.text(), /access_denied/);
    });

    test('rejects a login for an account that is not in subscription_accounts.yml', async () => {
      await startProxy((_, upstreamResponse) => sendJsonResponse(upstreamResponse, 200, {}));
      const { loginResponse, loginBody } = await startLogin('Unknown');
      assert.equal(loginResponse.status, 400);
      assert.match(loginBody.error, /Unknown/);
    });
  });
});
