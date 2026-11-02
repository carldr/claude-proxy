import assert from 'node:assert/strict';
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { GatewayAuthVerifier } from '../src/gateway_auth_verifier.ts';

interface ReceivedVerifyRequest {
  path: string;
  headers: IncomingHttpHeaders;
}

/** The headers that `fetch` adds to every request by itself. */
const fetchOwnHeaderNames = ['accept', 'accept-encoding', 'accept-language', 'connection', 'sec-fetch-mode', 'user-agent'];

const verifiedGatewayAuthToken = 'verified-gateway-auth-token';
const verifiedGateSession = 'verified-gate-session';

describe('GatewayAuthVerifier', () => {
  let fakeVerifyServer: http.Server;
  let fakeVerifyBaseUrl: string;
  let receivedVerifyRequests: ReceivedVerifyRequest[];

  /** Answers like Gateway Auth's `/verify`: 200 for the verified token or session, 401 otherwise. */
  function answerLikeGatewayAuth(receivedRequest: ReceivedVerifyRequest, verifyResponse: ServerResponse) {
    const authorization = receivedRequest.headers.authorization;
    const isVerified =
      authorization !== undefined
        ? authorization === `Bearer ${verifiedGatewayAuthToken}`
        : (receivedRequest.headers.cookie ?? '').split(';').findLast((cookiePair) => cookiePair.trim().startsWith('gate_session='))?.trim() ===
          `gate_session=${verifiedGateSession}`;
    verifyResponse.writeHead(isVerified ? 200 : 401, { 'content-type': 'application/json' });
    verifyResponse.end('{}');
  }

  beforeEach(async () => {
    receivedVerifyRequests = [];
    fakeVerifyServer = http.createServer((verifyRequest, verifyResponse) => {
      const receivedRequest = { path: verifyRequest.url ?? '', headers: verifyRequest.headers };
      receivedVerifyRequests.push(receivedRequest);
      if (receivedRequest.path.startsWith('/status-401')) {
        verifyResponse.writeHead(401);
        verifyResponse.end();
      } else if (receivedRequest.path.startsWith('/status-302')) {
        verifyResponse.writeHead(302, { location: '/login' });
        verifyResponse.end();
      } else if (receivedRequest.path.startsWith('/no-answer')) {
        // Gives no answer, so that the verifier times out.
      } else {
        answerLikeGatewayAuth(receivedRequest, verifyResponse);
      }
    });
    await new Promise<void>((resolve) => fakeVerifyServer.listen(0, '127.0.0.1', resolve));
    fakeVerifyBaseUrl = `http://127.0.0.1:${(fakeVerifyServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    fakeVerifyServer.closeAllConnections();
    await new Promise<void>((resolve) => fakeVerifyServer.close(() => resolve()));
  });

  function createVerifier(verifyPath = '/verify?team_id=test-team', timeoutMilliseconds = 5000) {
    return new GatewayAuthVerifier(new URL(`${fakeVerifyBaseUrl}${verifyPath}`), { cacheMilliseconds: 60_000, timeoutMilliseconds });
  }

  test('sends the bearer token and the cookie to the verify URL, and passes on a 200', async () => {
    const gatewayAuthVerifier = createVerifier();
    const cookieHeader = `theme=dark; gate_session=${verifiedGateSession}`;
    const isVerified = await gatewayAuthVerifier.isVerified({
      host: 'claude-proxy.example.test',
      authorization: `Bearer ${verifiedGatewayAuthToken}`,
      cookie: cookieHeader,
      'x-api-key': 'sk-client-key',
      origin: 'https://claude-proxy.example.test',
      'x-forwarded-for': '203.0.113.7',
    });
    assert.equal(isVerified, true);
    assert.equal(receivedVerifyRequests.length, 1);
    const receivedHeaders = receivedVerifyRequests[0]!.headers;
    assert.equal(receivedVerifyRequests[0]!.path, '/verify?team_id=test-team');
    assert.equal(receivedHeaders.authorization, `Bearer ${verifiedGatewayAuthToken}`);
    assert.equal(receivedHeaders.cookie, cookieHeader);
    assert.equal(receivedHeaders.host, new URL(fakeVerifyBaseUrl).host);
    assert.deepEqual(
      Object.keys(receivedHeaders).filter((headerName) => !fetchOwnHeaderNames.includes(headerName)).sort(),
      ['authorization', 'cookie', 'host'],
    );
  });

  test('refuses a non-Bearer authorization header alone, without calling the verify URL', async () => {
    const gatewayAuthVerifier = createVerifier();
    assert.equal(await gatewayAuthVerifier.isVerified({ authorization: `Basic ${verifiedGatewayAuthToken}` }), false);
    assert.equal(await gatewayAuthVerifier.isVerified({ authorization: verifiedGatewayAuthToken }), false);
    assert.equal(receivedVerifyRequests.length, 0);
  });

  test('does not forward a non-Bearer authorization header, and sends the cookie of a gate_session request', async () => {
    const gatewayAuthVerifier = createVerifier();
    const cookieHeader = `gate_session=${verifiedGateSession}`;
    assert.equal(await gatewayAuthVerifier.isVerified({ authorization: 'Basic abc', cookie: cookieHeader }), true);
    assert.equal(receivedVerifyRequests[0]!.headers.authorization, undefined);
    assert.equal(receivedVerifyRequests[0]!.headers.cookie, cookieHeader);
  });

  test('refuses on a 401, on a 302 and on no answer within the timeout', async () => {
    const credentialHeaders = { authorization: `Bearer ${verifiedGatewayAuthToken}` };
    assert.equal(await createVerifier('/status-401').isVerified(credentialHeaders), false);
    assert.equal(await createVerifier('/status-302').isVerified(credentialHeaders), false);
    const startedAt = performance.now();
    assert.equal(await createVerifier('/no-answer', 200).isVerified(credentialHeaders), false);
    assert.ok(performance.now() - startedAt < 1000);
    assert.equal(receivedVerifyRequests.length, 3);
  });

  test('refuses a request without a token or a gate_session cookie, without calling the verify URL', async () => {
    const gatewayAuthVerifier = createVerifier();
    assert.equal(await gatewayAuthVerifier.isVerified({}), false);
    assert.equal(await gatewayAuthVerifier.isVerified({ cookie: 'theme=dark; other_session=abc' }), false);
    assert.equal(await gatewayAuthVerifier.isVerified({ authorization: 'Bearer ' }), false);
    assert.equal(await gatewayAuthVerifier.isVerified({ authorization: 'Basic dXNlcjpwYXNz' }), false);
    assert.equal(receivedVerifyRequests.length, 0);
  });

  test('keeps a pass for the cache time, keyed by the token or the gate_session cookie', async (testContext) => {
    testContext.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const gatewayAuthVerifier = createVerifier();
    const tokenHeaders = { authorization: `Bearer ${verifiedGatewayAuthToken}` };

    assert.equal(await gatewayAuthVerifier.isVerified(tokenHeaders), true);
    testContext.mock.timers.tick(59_000);
    assert.equal(await gatewayAuthVerifier.isVerified(tokenHeaders), true);
    assert.equal(receivedVerifyRequests.length, 1);
    testContext.mock.timers.tick(2_000);
    assert.equal(await gatewayAuthVerifier.isVerified(tokenHeaders), true);
    assert.equal(receivedVerifyRequests.length, 2);

    assert.equal(await gatewayAuthVerifier.isVerified({ authorization: 'Bearer other-gateway-auth-token' }), false);
    assert.equal(receivedVerifyRequests.length, 3);
    assert.equal(await gatewayAuthVerifier.isVerified({ authorization: 'Bearer other-gateway-auth-token' }), false);
    assert.equal(receivedVerifyRequests.length, 4);

    const cookieHeaders = { cookie: `theme=dark; gate_session=${verifiedGateSession}` };
    assert.equal(await gatewayAuthVerifier.isVerified(cookieHeaders), true);
    assert.equal(await gatewayAuthVerifier.isVerified({ cookie: `gate_session=${verifiedGateSession}; theme=light` }), true);
    assert.equal(receivedVerifyRequests.length, 5);

    // A pass for a gate_session cookie does not pass a token with the same value.
    assert.equal(await gatewayAuthVerifier.isVerified({ authorization: `Bearer ${verifiedGateSession}` }), false);
    assert.equal(receivedVerifyRequests.length, 6);
  });

  test('keys a cookie pass by the last gate_session cookie, as Gateway Auth reads it', async () => {
    const gatewayAuthVerifier = createVerifier();
    assert.equal(await gatewayAuthVerifier.isVerified({ cookie: `gate_session=${verifiedGateSession}` }), true);
    assert.equal(await gatewayAuthVerifier.isVerified({ cookie: `gate_session=${verifiedGateSession}; gate_session=unverified` }), false);
    assert.equal(receivedVerifyRequests.length, 2);
  });
});
