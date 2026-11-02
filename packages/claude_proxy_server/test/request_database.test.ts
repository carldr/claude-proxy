import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { RequestDatabase, type StartedProxiedRequest } from '../src/request_database.ts';

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

function startedRequest(requestBody: Buffer): StartedProxiedRequest {
  return {
    startedAt: new Date().toISOString(),
    httpMethod: 'POST',
    requestPath: '/v1/messages?beta=true',
    clientAuthKind: 'oauth',
    model: 'claude-opus-5-5',
    isStreaming: true,
    sessionId: 'session-1',
    projectPath: '/Users/test/project',
    previousUpstreamRequestId: null,
    requestHeadersJson: '{}',
    requestBody,
    lastUserMessageText: '',
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

  test('stores an empty body as no body', () => {
    const requestDatabase = new RequestDatabase(databasePath);
    const proxiedRequestId = requestDatabase.insertStartedRequest(startedRequest(Buffer.alloc(0)));

    assert.equal(requestDatabase.readProxiedRequest(proxiedRequestId)?.request_body, null);
    requestDatabase.close();
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
