import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { RequestDatabase, type CompletedProxiedRequest, type ProxiedRequestFilters, type StartedProxiedRequest } from '../src/request_database.ts';

const largeSafeguards = { rules: 'x'.repeat(5000) };
const largeTools = [{ name: 'Read', description: 'y'.repeat(5000) }];

function messagesRequestBody(messageCount: number): Record<string, unknown> {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    system: [{ type: 'text', text: 'z'.repeat(2000) }],
    messages: Array.from({ length: messageCount }, (_, messageIndex) => ({
      role: messageIndex % 2 === 0 ? 'user' : 'assistant',
      content: `message ${messageIndex} ${'w'.repeat(1000)}`,
    })),
    tools: largeTools,
    safeguards: largeSafeguards,
    stream: true,
  };
}

function completedRequest(responseText: string): CompletedProxiedRequest {
  return {
    completedAt: new Date().toISOString(),
    durationMs: 10,
    routeKind: 'subscription_account',
    routeName: 'Work',
    statusCode: 200,
    errorType: null,
    stopReason: 'end_turn',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheReadInputTokens: 0,
    estimatedCostUsd: 0.5,
    responseHeadersJson: '{"request-id":"req_1"}',
    responseBody: `{"content":"${responseText}"}`,
    responseText,
    responseToolText: '',
  };
}

function startedRequest(requestBody: Buffer, startedAt = new Date().toISOString(), lastUserMessageText = ''): StartedProxiedRequest {
  return {
    startedAt,
    httpMethod: 'POST',
    requestPath: '/v1/messages?beta=true',
    clientAuthKind: 'oauth',
    model: 'claude-opus-5-5',
    isStreaming: true,
    sessionId: 'session-1',
    projectPath: '/Users/test/project',
    projectName: null,
    startingBranch: null,
    sourceHostname: null,
    previousUpstreamRequestId: null,
    requestHeadersJson: '{"user-agent":"claude-cli"}',
    requestBody,
    lastUserMessageText,
    lastUserMessageToolResultText: '',
  };
}

describe('request bodies in the request database', () => {
  let databaseDirectory: string;
  let databasePath: string;

  beforeEach(() => {
    databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-request-database-'));
    databasePath = path.join(databaseDirectory, 'requests.sqlite');
  });

  afterEach(() => {
    fs.rmSync(databaseDirectory, { recursive: true, force: true });
  });

  function countRows(tableName: string, whereClause = ''): number {
    const inspectionDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return (inspectionDatabase.prepare(`SELECT COUNT(*) AS row_count FROM ${tableName} ${whereClause}`).get() as { row_count: number })
        .row_count;
    } finally {
      inspectionDatabase.close();
    }
  }

  test('stores a JSON body as parts and reads it back byte for byte', () => {
    const requestDatabase = new RequestDatabase(databasePath);
    const requestBodyText = JSON.stringify(messagesRequestBody(3));
    const proxiedRequestId = requestDatabase.insertStartedRequest(startedRequest(Buffer.from(requestBodyText)));

    assert.equal(requestDatabase.readProxiedRequest(proxiedRequestId)?.request_body, requestBodyText);
    requestDatabase.close();
    assert.equal(countRows('proxied_requests', 'WHERE request_body_zstd IS NOT NULL'), 0);
  });

  test('stores each message, the tools and the safeguards once across the requests of a conversation', () => {
    const requestDatabase = new RequestDatabase(databasePath);
    requestDatabase.insertStartedRequest(startedRequest(Buffer.from(JSON.stringify(messagesRequestBody(3)))));
    const partCountAfterFirstRequest = countRows('request_body_parts');
    const laterRequestBodyText = JSON.stringify(messagesRequestBody(5));
    const laterProxiedRequestId = requestDatabase.insertStartedRequest(startedRequest(Buffer.from(laterRequestBodyText)));

    // The later request adds only its two new messages: system, tools, safeguards and the first three messages are stored already.
    assert.equal(countRows('request_body_parts'), partCountAfterFirstRequest + 2);
    assert.equal(requestDatabase.readProxiedRequest(laterProxiedRequestId)?.request_body, laterRequestBodyText);
    requestDatabase.close();
  });

  test('stores a body whole when compact JSON does not rebuild it exactly', () => {
    const requestDatabase = new RequestDatabase(databasePath);
    const spacedRequestBodyText = JSON.stringify(messagesRequestBody(1), null, 1);
    const spacedProxiedRequestId = requestDatabase.insertStartedRequest(startedRequest(Buffer.from(spacedRequestBodyText)));
    const textRequestBody = 'not JSON';
    const textProxiedRequestId = requestDatabase.insertStartedRequest(startedRequest(Buffer.from(textRequestBody)));

    assert.equal(requestDatabase.readProxiedRequest(spacedProxiedRequestId)?.request_body, spacedRequestBodyText);
    assert.equal(requestDatabase.readProxiedRequest(textProxiedRequestId)?.request_body, textRequestBody);
    requestDatabase.close();
    assert.equal(countRows('proxied_requests', 'WHERE request_body_zstd IS NOT NULL'), 2);
  });

  test('stores the project, starting branch and source hostname that the client sends, and filters by them', () => {
    const requestDatabase = new RequestDatabase(databasePath);
    const attributedRequestId = requestDatabase.insertStartedRequest({
      ...startedRequest(Buffer.alloc(0)),
      projectName: 'example-org/example-repo',
      startingBranch: 'feature/login',
      sourceHostname: 'example-host',
    });
    const unattributedRequestId = requestDatabase.insertStartedRequest({ ...startedRequest(Buffer.alloc(0)), sessionId: 'session-2' });

    const attributedRequest = requestDatabase.readProxiedRequest(attributedRequestId);
    assert.equal(attributedRequest?.project_name, 'example-org/example-repo');
    assert.equal(attributedRequest?.starting_branch, 'feature/login');
    assert.equal(attributedRequest?.source_hostname, 'example-host');
    assert.equal(attributedRequest?.project_path, '/Users/test/project');

    const unattributedRequest = requestDatabase.readProxiedRequest(unattributedRequestId);
    assert.equal(unattributedRequest?.project_name, null);
    assert.equal(unattributedRequest?.starting_branch, null);
    assert.equal(unattributedRequest?.source_hostname, null);
    assert.equal(unattributedRequest?.project_path, '/Users/test/project');

    const listRequestIds = (filters: ProxiedRequestFilters) => requestDatabase.listProxiedRequests(filters, { limit: 10 }).map((request) => request.id);
    assert.deepEqual(listRequestIds({ projectName: 'example-org/example-repo' }), [attributedRequestId]);
    assert.deepEqual(listRequestIds({ startingBranch: 'feature/login' }), [attributedRequestId]);
    assert.deepEqual(listRequestIds({ sourceHostname: 'example-host' }), [attributedRequestId]);
    assert.deepEqual(listRequestIds({ isProjectUnattributed: true }), [unattributedRequestId]);

    assert.deepEqual(requestDatabase.listSessions({ projectName: 'example-org/example-repo' }, 10).map((session) => session.session_id), ['session-1']);
    assert.deepEqual(requestDatabase.listSessions({ isProjectUnattributed: true }, 10).map((session) => session.session_id), ['session-2']);
    assert.equal(requestDatabase.listSessions({ projectName: 'example-org/example-repo' }, 10)[0]?.source_hostname, 'example-host');
    assert.equal(requestDatabase.listSessions({ projectName: 'example-org/example-repo' }, 10)[0]?.starting_branch, 'feature/login');

    const filterOptions = requestDatabase.listRequestFilterOptions(new Date().toISOString());
    assert.deepEqual(filterOptions.projectNames, ['example-org/example-repo']);
    assert.deepEqual(filterOptions.startingBranches, ['feature/login']);
    assert.deepEqual(filterOptions.sourceHostnames, ['example-host']);
    requestDatabase.close();
  });

  test('gives a database made before the attribution columns those columns, and leaves its rows unattributed', () => {
    const firstDatabase = new RequestDatabase(databasePath);
    const oldProxiedRequestId = firstDatabase.insertStartedRequest(startedRequest(Buffer.alloc(0)));
    firstDatabase.close();
    const olderDatabase = new DatabaseSync(databasePath);
    olderDatabase.exec(`
      DROP INDEX proxied_requests_project_name;
      DROP INDEX proxied_requests_starting_branch;
      DROP INDEX proxied_requests_source_hostname;
      ALTER TABLE proxied_requests DROP COLUMN project_name;
      ALTER TABLE proxied_requests DROP COLUMN starting_branch;
      ALTER TABLE proxied_requests DROP COLUMN source_hostname;
    `);
    olderDatabase.close();

    const requestDatabase = new RequestDatabase(databasePath);
    const oldRequest = requestDatabase.readProxiedRequest(oldProxiedRequestId);
    assert.equal(oldRequest?.project_name, null);
    assert.equal(oldRequest?.starting_branch, null);
    assert.equal(oldRequest?.source_hostname, null);
    requestDatabase.close();
  });

  test('stores an empty body as no body', () => {
    const requestDatabase = new RequestDatabase(databasePath);
    const proxiedRequestId = requestDatabase.insertStartedRequest(startedRequest(Buffer.alloc(0)));

    assert.equal(requestDatabase.readProxiedRequest(proxiedRequestId)?.request_body, null);
    requestDatabase.close();
  });

  test('finds a request by its user text and its response text, and shows the preview, after the response', () => {
    const requestDatabase = new RequestDatabase(databasePath);
    const proxiedRequestId = requestDatabase.insertStartedRequest(
      startedRequest(Buffer.from(JSON.stringify(messagesRequestBody(1))), undefined, 'Find the zebra bug'),
    );
    requestDatabase.completeRequest(proxiedRequestId, completedRequest('The giraffe fixed it'));

    for (const searchText of ['zebra', 'giraffe']) {
      assert.deepEqual(
        requestDatabase.listProxiedRequests({ searchText }, { limit: 10 }).map((proxiedRequest) => proxiedRequest.id),
        [proxiedRequestId],
        `search for ${searchText}`,
      );
    }
    assert.equal(requestDatabase.listProxiedRequests({}, { limit: 10 })[0].user_text_preview, 'Find the zebra bug');
    assert.equal(requestDatabase.readProxiedRequest(proxiedRequestId)?.request_headers_json, '{"user-agent":"claude-cli"}');
    assert.equal(requestDatabase.readProxiedRequest(proxiedRequestId)?.response_headers_json, '{"request-id":"req_1"}');
    requestDatabase.close();
  });

  test('expires the contents of old requests, keeps their costs, and keeps the parts that a later request uses', () => {
    const requestDatabase = new RequestDatabase(databasePath);
    const oldProxiedRequestId = requestDatabase.insertStartedRequest(
      startedRequest(Buffer.from(JSON.stringify(messagesRequestBody(2))), '2025-01-01T10:00:00.000Z', 'The old zebra prompt'),
    );
    requestDatabase.completeRequest(oldProxiedRequestId, completedRequest('An old reply'));
    const partCountOfOldRequest = countRows('request_body_parts');
    // The later request drops the first message, keeps the second, and adds a third.
    const laterMessages = (messagesRequestBody(3).messages as unknown[]).slice(1);
    const laterRequestBodyText = JSON.stringify({ ...messagesRequestBody(3), messages: laterMessages });
    const laterProxiedRequestId = requestDatabase.insertStartedRequest(
      startedRequest(Buffer.from(laterRequestBodyText), '2026-06-01T10:00:00.000Z'),
    );

    assert.equal(requestDatabase.expireRequestContentsStartedBefore('2026-01-01T00:00:00.000Z'), 1);

    const oldRequest = requestDatabase.readProxiedRequest(oldProxiedRequestId);
    assert.equal(oldRequest?.request_body, null);
    assert.equal(oldRequest?.response_body, null);
    assert.equal(oldRequest?.request_headers_json, null);
    assert.equal(oldRequest?.user_text_preview, null);
    assert.ok(oldRequest?.contents_expired_at);
    assert.equal(oldRequest?.estimated_cost_usd, 0.5);
    assert.equal(requestDatabase.listProxiedRequests({ searchText: 'zebra' }, { limit: 10 }).length, 0);
    assert.equal(requestDatabase.readProxiedRequest(laterProxiedRequestId)?.request_body, laterRequestBodyText);
    // The later request added its third message, and the expiry deleted the first, which only the old request used.
    assert.equal(countRows('request_body_parts'), partCountOfOldRequest);
    assert.equal(requestDatabase.expireRequestContentsStartedBefore('2026-01-01T00:00:00.000Z'), 0);
    requestDatabase.close();
  });

  test('migrates the plain headers and the search table of an earlier database', () => {
    const earlierDatabase = new DatabaseSync(databasePath);
    earlierDatabase.exec(`
      CREATE TABLE proxied_requests (
        id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER, http_method TEXT NOT NULL,
        request_path TEXT NOT NULL, client_auth_kind TEXT NOT NULL, route_kind TEXT, route_name TEXT, model TEXT,
        is_streaming INTEGER NOT NULL, session_id TEXT, project_path TEXT, is_project_path_inherited INTEGER NOT NULL DEFAULT 0,
        status_code INTEGER, error_type TEXT, stop_reason TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cache_creation_5m_input_tokens INTEGER, cache_creation_1h_input_tokens INTEGER, cache_read_input_tokens INTEGER,
        estimated_cost_usd REAL, request_headers_json TEXT NOT NULL, request_body_zstd BLOB, response_headers_json TEXT,
        response_body_zstd BLOB, upstream_request_id TEXT
      );
      CREATE VIRTUAL TABLE proxied_request_search USING fts5 (user_text, tool_text, response_text);
      INSERT INTO proxied_requests (id, started_at, http_method, request_path, client_auth_kind, is_streaming, session_id,
        request_headers_json, response_headers_json)
        VALUES (1, '2026-10-20T10:00:00.000Z', 'POST', '/v1/messages', 'oauth', 1, 'session-1', '{"a":"1"}', '{"b":"2"}');
      INSERT INTO proxied_request_search (rowid, user_text, tool_text, response_text) VALUES (1, 'An earlier zebra prompt', '', 'A reply');
    `);
    earlierDatabase.close();

    const requestDatabase = new RequestDatabase(databasePath);
    const migratedRequest = requestDatabase.readProxiedRequest(1);
    assert.equal(migratedRequest?.request_headers_json, '{"a":"1"}');
    assert.equal(migratedRequest?.response_headers_json, '{"b":"2"}');
    assert.equal(migratedRequest?.user_text_preview, 'An earlier zebra prompt');
    assert.equal(requestDatabase.listProxiedRequests({ searchText: 'zebra' }, { limit: 10 }).length, 1);
    assert.equal(requestDatabase.listSessions({}, 10)[0]!.first_user_text, 'An earlier zebra prompt');
    requestDatabase.close();
    assert.equal(countRows('sqlite_schema', "WHERE name = 'proxied_request_search'"), 0);
  });

  test('splits the whole bodies of an earlier database into parts when it opens', () => {
    const requestBodyText = JSON.stringify(messagesRequestBody(4));
    const spacedRequestBodyText = JSON.stringify(messagesRequestBody(1), null, 1);
    const firstRequestDatabase = new RequestDatabase(databasePath);
    const proxiedRequestId = firstRequestDatabase.insertStartedRequest(startedRequest(Buffer.from(requestBodyText)));
    const spacedProxiedRequestId = firstRequestDatabase.insertStartedRequest(startedRequest(Buffer.from(spacedRequestBodyText)));
    firstRequestDatabase.close();

    // Make the database look like one from before request body parts: whole bodies, no parts, no finished split.
    const earlierDatabase = new DatabaseSync(databasePath);
    earlierDatabase
      .prepare('UPDATE proxied_requests SET request_body_zstd = ?, request_body_layout_zstd = NULL WHERE id = ?')
      .run(zstdCompressSync(Buffer.from(requestBodyText)), proxiedRequestId);
    earlierDatabase.exec("DELETE FROM request_body_parts; DELETE FROM proxy_settings WHERE setting_name = 'request_body_parts_split'");
    earlierDatabase.close();

    const reopenedRequestDatabase = new RequestDatabase(databasePath);
    assert.equal(reopenedRequestDatabase.readProxiedRequest(proxiedRequestId)?.request_body, requestBodyText);
    assert.equal(reopenedRequestDatabase.readProxiedRequest(spacedProxiedRequestId)?.request_body, spacedRequestBodyText);
    reopenedRequestDatabase.close();
    assert.equal(countRows('proxied_requests', 'WHERE request_body_zstd IS NOT NULL'), 1);
    assert.ok(countRows('request_body_parts') > 0);
  });
});
