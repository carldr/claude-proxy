import assert from 'node:assert/strict';
import fs from 'node:fs';
import http, { type IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createClaudeProxyRelay, readClaudeProxyRelayConfiguration } from '../src/claude_proxy_relay.ts';

const gatewayAuthToken = 'relay-test-gateway-auth-token';
const relayProxyCredential = 'relay-test-proxy-credential';
/** The `Basic` credentials that a client of the relay sends, in `Proxy-Authorization` on a CONNECT and in `Authorization` on a GET. */
const relayBasicCredentials = `Basic ${Buffer.from(`relay:${relayProxyCredential}`).toString('base64')}`;
const certificateAuthorityPem = '-----BEGIN CERTIFICATE-----\nMIIBfakecertificate\n-----END CERTIFICATE-----\n';
/** A certificate authority file from an earlier download, which the fake central service's certificate replaces. */
const existingCertificateAuthorityPem = '-----BEGIN CERTIFICATE-----\nexisting\n-----END CERTIFICATE-----\n';
const subscriptionAccountStatusBody = JSON.stringify({ subscriptionAccounts: [{ name: 'Work', weeklyUtilization: 0.4 }] });

/** What the fake central service received: each upgrade request and each plain request. */
interface FakeCentralService {
  url: URL;
  receivedRequests: { method: string; path: string; headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
}

type FakeCentralUpgradeAnswer = 'switch_protocols_and_echo' | 'switch_protocols_to_websocket' | 'redirect_to_login';

/**
 * A local HTTP server that stands in for the central claude-proxy behind Caddy. It answers the first
 * `certificateAuthorityFailureCount` certificate requests with 503.
 */
async function startFakeCentralService(upgradeAnswer: FakeCentralUpgradeAnswer, certificateAuthorityFailureCount = 0): Promise<FakeCentralService> {
  const receivedRequests: FakeCentralService['receivedRequests'] = [];
  const openSockets = new Set<Duplex>();
  let certificateAuthorityRequestCount = 0;
  const fakeCentralServer = http.createServer((centralRequest, centralResponse) => {
    receivedRequests.push({ method: centralRequest.method ?? '', path: centralRequest.url ?? '', headers: centralRequest.headers });
    if (centralRequest.url === '/_proxy/api/subscription-account-status') {
      centralResponse.writeHead(200, { 'content-type': 'application/json' }).end(subscriptionAccountStatusBody);
    } else if (centralRequest.url === '/_proxy/certificate_authority.pem') {
      certificateAuthorityRequestCount += 1;
      if (certificateAuthorityRequestCount <= certificateAuthorityFailureCount) centralResponse.writeHead(503).end();
      else centralResponse.writeHead(200, { 'content-type': 'application/x-pem-file' }).end(certificateAuthorityPem);
    } else {
      centralResponse.writeHead(404).end();
    }
  });
  fakeCentralServer.on('upgrade', (upgradeRequest, centralSocket: Duplex) => {
    openSockets.add(centralSocket);
    centralSocket.on('error', () => centralSocket.destroy());
    receivedRequests.push({ method: upgradeRequest.method ?? '', path: upgradeRequest.url ?? '', headers: upgradeRequest.headers });
    if (upgradeAnswer === 'redirect_to_login') {
      centralSocket.end('HTTP/1.1 302 Found\r\nlocation: https://gateway-auth.example/login\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      return;
    }
    if (upgradeAnswer === 'switch_protocols_to_websocket') {
      centralSocket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      centralSocket.on('data', (tunnelChunk: Buffer) => centralSocket.write(`websocket:${tunnelChunk.toString('utf8')}`));
      return;
    }
    centralSocket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: claude-proxy-tunnel\r\n\r\n');
    centralSocket.on('data', (tunnelChunk: Buffer) => centralSocket.write(`central:${tunnelChunk.toString('utf8')}`));
  });
  await new Promise<void>((resolve) => fakeCentralServer.listen(0, '127.0.0.1', resolve));
  return {
    url: new URL(`http://127.0.0.1:${(fakeCentralServer.address() as AddressInfo).port}`),
    receivedRequests,
    async close() {
      for (const openSocket of openSockets) openSocket.destroy();
      fakeCentralServer.closeAllConnections();
      await new Promise<void>((resolve) => fakeCentralServer.close(() => resolve()));
    },
  };
}

/** A TCP server that prefixes each chunk it receives with `prefix` and sends it back. */
async function startPrefixEchoServer(prefix: string) {
  const openSockets = new Set<net.Socket>();
  const prefixEchoServer = net.createServer((echoSocket) => {
    openSockets.add(echoSocket);
    echoSocket.on('error', () => echoSocket.destroy());
    echoSocket.on('data', (echoChunk) => echoSocket.write(`${prefix}${echoChunk.toString('utf8')}`));
  });
  await new Promise<void>((resolve) => prefixEchoServer.listen(0, '127.0.0.1', resolve));
  return {
    port: (prefixEchoServer.address() as AddressInfo).port,
    acceptedConnectionCount: () => openSockets.size,
    async close() {
      for (const openSocket of openSockets) openSocket.destroy();
      await new Promise<void>((resolve) => prefixEchoServer.close(() => resolve()));
    },
  };
}

/** A TCP server that accepts each connection and never writes, like a central service that hangs. */
async function startSilentServer() {
  const openSockets = new Set<net.Socket>();
  const silentServer = net.createServer((silentSocket) => {
    openSockets.add(silentSocket);
    silentSocket.on('error', () => silentSocket.destroy());
  });
  await new Promise<void>((resolve) => silentServer.listen(0, '127.0.0.1', resolve));
  return {
    url: new URL(`http://127.0.0.1:${(silentServer.address() as AddressInfo).port}`),
    async close() {
      for (const openSocket of openSockets) openSocket.destroy();
      await new Promise<void>((resolve) => silentServer.close(() => resolve()));
    },
  };
}

/** Returns a loopback URL whose port nothing listens on. */
async function findClosedPortUrl(): Promise<URL> {
  const portFinderServer = net.createServer();
  await new Promise<void>((resolve) => portFinderServer.listen(0, '127.0.0.1', resolve));
  const closedPort = (portFinderServer.address() as AddressInfo).port;
  await new Promise<void>((resolve) => portFinderServer.close(() => resolve()));
  return new URL(`http://127.0.0.1:${closedPort}`);
}

/** Reads from `socket` until the text received ends with `expectedEnding`, and returns all of it. */
function readUntil(socket: net.Socket, expectedEnding: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let receivedText = '';
    const onData = (receivedChunk: Buffer) => {
      receivedText += receivedChunk.toString('utf8');
      if (receivedText.endsWith(expectedEnding)) {
        socket.off('data', onData);
        resolve(receivedText);
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('close', () => reject(new Error(`the socket closed after ${JSON.stringify(receivedText)}`)));
  });
}

/** Returns the CONNECT request head for `connectTarget`, with `Proxy-Authorization: proxyAuthorization` unless it is null. */
function connectRequestHead(connectTarget: string, proxyAuthorization: string | null = relayBasicCredentials) {
  const proxyAuthorizationLine = proxyAuthorization === null ? '' : `Proxy-Authorization: ${proxyAuthorization}\r\n`;
  return `CONNECT ${connectTarget} HTTP/1.1\r\nHost: ${connectTarget}\r\n${proxyAuthorizationLine}\r\n`;
}

/** Sends `CONNECT connectTarget` to the relay, then `payload` through the tunnel. Returns the CONNECT answer and the tunnel's answer. */
async function connectThroughRelay(
  relayPort: number,
  connectTarget: string,
  payload: string,
  expectedTunnelAnswer: string,
  proxyAuthorization: string | null = relayBasicCredentials,
) {
  const clientSocket = net.connect(relayPort, '127.0.0.1');
  try {
    clientSocket.write(connectRequestHead(connectTarget, proxyAuthorization));
    const connectAnswer = await readUntil(clientSocket, '\r\n\r\n');
    clientSocket.write(payload);
    const tunnelAnswer = await readUntil(clientSocket, expectedTunnelAnswer);
    return { connectAnswer, tunnelAnswer };
  } finally {
    clientSocket.destroy();
  }
}

/** Sends a GET to the relay with the given Host and `Authorization`, unless it is null, and returns the status, the headers and the body. */
async function getFromRelay(relayPort: number, requestPath: string, hostHeader = `127.0.0.1:${relayPort}`, authorization: string | null = relayBasicCredentials) {
  return new Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const requestHeaders: Record<string, string> = { host: hostHeader };
    if (authorization !== null) requestHeaders.authorization = authorization;
    const relayRequest = http.request({ host: '127.0.0.1', port: relayPort, path: requestPath, headers: requestHeaders, agent: false }, (relayResponse) => {
      const bodyChunks: Buffer[] = [];
      relayResponse.on('data', (bodyChunk: Buffer) => bodyChunks.push(bodyChunk));
      relayResponse.on('end', () =>
        resolve({ statusCode: relayResponse.statusCode ?? 0, headers: relayResponse.headers, body: Buffer.concat(bodyChunks).toString('utf8') }),
      );
    });
    relayRequest.on('error', reject);
    relayRequest.end();
  });
}

describe('claude_proxy_relay', () => {
  let relayDirectory: string;
  let fakeAnthropicServer: Awaited<ReturnType<typeof startPrefixEchoServer>>;
  const closeAfterTest: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relayDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude_proxy_relay_test_'));
    fakeAnthropicServer = await startPrefixEchoServer('anthropic:');
    closeAfterTest.push(() => fakeAnthropicServer.close());
  });

  afterEach(async () => {
    for (const closeOne of closeAfterTest.splice(0).reverse()) await closeOne();
    fs.rmSync(relayDirectory, { recursive: true, force: true });
  });

  /**
   * Starts a relay against `centralUrl`. By default it first writes an existing `certificate_authority.pem`,
   * because the relay tunnels directly without one.
   */
  async function startRelay(
    centralUrl: URL,
    { tunnelUpgradeTimeoutMilliseconds = 5000, hasCertificateAuthorityFile = true, certificateAuthorityDownloadRetryMilliseconds = 60_000 } = {},
  ) {
    if (hasCertificateAuthorityFile) fs.writeFileSync(path.join(relayDirectory, 'certificate_authority.pem'), existingCertificateAuthorityPem);
    const claudeProxyRelay = createClaudeProxyRelay({
      centralUrl,
      gatewayAuthToken,
      relayProxyCredential,
      relayDirectory,
      anthropicApiHost: '127.0.0.1',
      anthropicApiPort: fakeAnthropicServer.port,
      tunnelUpgradeTimeoutMilliseconds,
      certificateAuthorityDownloadRetryMilliseconds,
    });
    await new Promise<void>((resolve) => claudeProxyRelay.httpServer.listen(0, '127.0.0.1', resolve));
    closeAfterTest.unshift(() => claudeProxyRelay.close());
    return { claudeProxyRelay, relayPort: (claudeProxyRelay.httpServer.address() as AddressInfo).port };
  }

  async function startCentral(upgradeAnswer: FakeCentralUpgradeAnswer, certificateAuthorityFailureCount = 0) {
    const fakeCentralService = await startFakeCentralService(upgradeAnswer, certificateAuthorityFailureCount);
    closeAfterTest.push(() => fakeCentralService.close());
    return fakeCentralService;
  }

  test('sends an api.anthropic.com CONNECT through the central tunnel with the token', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { relayPort } = await startRelay(fakeCentralService.url);
    const { connectAnswer, tunnelAnswer } = await connectThroughRelay(relayPort, 'api.anthropic.com:443', 'client hello', 'central:client hello');
    assert.equal(connectAnswer, 'HTTP/1.1 200 Connection Established\r\n\r\n');
    assert.equal(tunnelAnswer, 'central:client hello');
    const upgradeRequest = fakeCentralService.receivedRequests.find((receivedRequest) => receivedRequest.path === '/_proxy/tunnel');
    assert.ok(upgradeRequest);
    assert.equal(upgradeRequest.method, 'GET');
    assert.equal(upgradeRequest.headers['x-gateway-auth-token'], gatewayAuthToken);
    assert.equal(upgradeRequest.headers.upgrade, 'claude-proxy-tunnel');
    assert.equal(upgradeRequest.headers.connection?.toLowerCase(), 'upgrade');
    assert.equal(upgradeRequest.headers.host, fakeCentralService.url.host);
    assert.equal(upgradeRequest.headers.origin, undefined);
  });

  test('falls back to a direct tunnel when the central service answers without 101', async () => {
    const fakeCentralService = await startCentral('redirect_to_login');
    const { relayPort } = await startRelay(fakeCentralService.url);
    const { connectAnswer, tunnelAnswer } = await connectThroughRelay(relayPort, 'api.anthropic.com:443', 'client hello', 'anthropic:client hello');
    assert.equal(connectAnswer, 'HTTP/1.1 200 Connection Established\r\n\r\n');
    assert.equal(tunnelAnswer, 'anthropic:client hello');
  });

  test('falls back to a direct tunnel when the central service does not answer within 5 seconds', async () => {
    const silentServer = await startSilentServer();
    closeAfterTest.push(() => silentServer.close());
    const { relayPort } = await startRelay(silentServer.url, { tunnelUpgradeTimeoutMilliseconds: 200 });
    const startedAt = Date.now();
    const { tunnelAnswer } = await connectThroughRelay(relayPort, 'api.anthropic.com:443', 'client hello', 'anthropic:client hello');
    assert.equal(tunnelAnswer, 'anthropic:client hello');
    assert.ok(Date.now() - startedAt < 1000, `the direct tunnel took ${Date.now() - startedAt} ms`);
  });

  test('tunnels another host from this machine', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const otherHostServer = await startPrefixEchoServer('other:');
    closeAfterTest.push(() => otherHostServer.close());
    const { relayPort, claudeProxyRelay } = await startRelay(fakeCentralService.url);
    const { connectAnswer, tunnelAnswer } = await connectThroughRelay(relayPort, `127.0.0.1:${otherHostServer.port}`, 'ping', 'other:ping');
    assert.equal(connectAnswer, 'HTTP/1.1 200 Connection Established\r\n\r\n');
    assert.equal(tunnelAnswer, 'other:ping');
    // Wait for the start-up certificate download, so that only a tunnel request could remain.
    await claudeProxyRelay.close();
    assert.deepEqual(
      fakeCentralService.receivedRequests.filter((receivedRequest) => receivedRequest.path !== '/_proxy/certificate_authority.pem'),
      [],
    );
  });

  test('answers 502 when a direct tunnel cannot reach its target', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { relayPort } = await startRelay(fakeCentralService.url);
    const closedPortUrl = await findClosedPortUrl();
    const clientSocket = net.connect(relayPort, '127.0.0.1');
    clientSocket.write(connectRequestHead(closedPortUrl.host));
    const connectAnswer = await readUntil(clientSocket, '\n');
    clientSocket.destroy();
    assert.match(connectAnswer, /^HTTP\/1\.1 502 Bad Gateway\r\n/);
  });

  test('carries ten tunnels at once', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { relayPort } = await startRelay(fakeCentralService.url);
    const tunnelNumbers = Array.from({ length: 10 }, (_, tunnelIndex) => tunnelIndex);
    const tunnelAnswers = await Promise.all(
      tunnelNumbers.map((tunnelNumber) =>
        connectThroughRelay(relayPort, 'api.anthropic.com:443', `tunnel ${tunnelNumber}`, `central:tunnel ${tunnelNumber}`),
      ),
    );
    assert.deepEqual(
      tunnelAnswers.map((tunnelAnswer) => tunnelAnswer.tunnelAnswer),
      tunnelNumbers.map((tunnelNumber) => `central:tunnel ${tunnelNumber}`),
    );
  });

  test('forwards the subscription account status with the token', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { relayPort } = await startRelay(fakeCentralService.url);
    const statusAnswer = await getFromRelay(relayPort, '/_proxy/api/subscription-account-status');
    assert.deepEqual({ statusCode: statusAnswer.statusCode, body: statusAnswer.body }, { statusCode: 200, body: subscriptionAccountStatusBody });
    const statusRequest = fakeCentralService.receivedRequests.find((receivedRequest) => receivedRequest.path === '/_proxy/api/subscription-account-status');
    assert.ok(statusRequest);
    assert.equal(statusRequest.headers['x-gateway-auth-token'], gatewayAuthToken);
    assert.equal(statusRequest.headers.host, fakeCentralService.url.host);
    assert.equal(statusRequest.headers.origin, undefined);

    const { relayPort: relayPortWithCentralDown } = await startRelay(await findClosedPortUrl());
    const statusAnswerWithCentralDown = await getFromRelay(relayPortWithCentralDown, '/_proxy/api/subscription-account-status');
    assert.equal(statusAnswerWithCentralDown.statusCode, 502);
  });

  test('refuses a CONNECT without the proxy credential', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const otherHostServer = await startPrefixEchoServer('other:');
    closeAfterTest.push(() => otherHostServer.close());
    const { relayPort } = await startRelay(fakeCentralService.url);
    const basicCredentials = (credentialPair: string) => `Basic ${Buffer.from(credentialPair).toString('base64')}`;
    const refusedProxyAuthorizations = [
      null,
      basicCredentials('relay:wrong-proxy-credential'),
      basicCredentials(`other-user:${relayProxyCredential}`),
      basicCredentials(relayProxyCredential),
      `Bearer ${relayProxyCredential}`,
    ];
    for (const connectTarget of ['api.anthropic.com:443', `127.0.0.1:${otherHostServer.port}`]) {
      for (const proxyAuthorization of refusedProxyAuthorizations) {
        const clientSocket = net.connect(relayPort, '127.0.0.1');
        const socketClosed = new Promise<void>((resolve) => clientSocket.on('close', () => resolve()));
        let connectAnswer = '';
        clientSocket.on('data', (answerChunk: Buffer) => (connectAnswer += answerChunk.toString('utf8')));
        clientSocket.write(connectRequestHead(connectTarget, proxyAuthorization));
        await socketClosed;
        assert.match(connectAnswer, /^HTTP\/1\.1 407 Proxy Authentication Required\r\n/, `${connectTarget} with ${proxyAuthorization}`);
        assert.match(connectAnswer, /\r\nProxy-Authenticate: Basic realm="claude-proxy-relay"\r\n/i);
      }
    }
    assert.equal(fakeAnthropicServer.acceptedConnectionCount(), 0);
    assert.equal(otherHostServer.acceptedConnectionCount(), 0);
    assert.equal(fakeCentralService.receivedRequests.filter((receivedRequest) => receivedRequest.path === '/_proxy/tunnel').length, 0);
  });

  test('accepts a CONNECT with the proxy credential and a lower-case scheme', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { relayPort } = await startRelay(fakeCentralService.url);
    const lowerCaseSchemeCredentials = relayBasicCredentials.replace(/^Basic/, 'basic');
    const { connectAnswer, tunnelAnswer } = await connectThroughRelay(relayPort, 'api.anthropic.com:443', 'client hello', 'central:client hello', lowerCaseSchemeCredentials);
    assert.equal(connectAnswer, 'HTTP/1.1 200 Connection Established\r\n\r\n');
    assert.equal(tunnelAnswer, 'central:client hello');
  });

  test('refuses the status request without the credential', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { relayPort } = await startRelay(fakeCentralService.url);
    const relayHost = `127.0.0.1:${relayPort}`;
    for (const authorization of [null, `Basic ${Buffer.from('relay:wrong-proxy-credential').toString('base64')}`]) {
      const refusedAnswer = await getFromRelay(relayPort, '/_proxy/api/subscription-account-status', relayHost, authorization);
      assert.equal(refusedAnswer.statusCode, 401);
      assert.equal(refusedAnswer.headers['www-authenticate'], 'Basic realm="claude-proxy-relay"');
    }
    assert.equal(fakeCentralService.receivedRequests.filter((receivedRequest) => receivedRequest.path === '/_proxy/api/subscription-account-status').length, 0);
    assert.equal((await getFromRelay(relayPort, '/_proxy/api/subscription-account-status', relayHost)).statusCode, 200);
  });

  test('answers the relay status itself, without a request to the central claude-proxy', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { relayPort } = await startRelay(fakeCentralService.url);
    const relayStatusAnswer = await getFromRelay(relayPort, '/_proxy/relay-status');
    assert.deepEqual({ statusCode: relayStatusAnswer.statusCode, body: relayStatusAnswer.body }, { statusCode: 200, body: '{"relay":"ok"}' });
    assert.equal(fakeCentralService.receivedRequests.filter((receivedRequest) => receivedRequest.path === '/_proxy/relay-status').length, 0);
    assert.equal(fakeCentralService.receivedRequests.filter((receivedRequest) => receivedRequest.path.startsWith('/_proxy/api/')).length, 0);
  });

  test('refuses the relay status request without the credential', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { relayPort } = await startRelay(fakeCentralService.url);
    const refusedAnswer = await getFromRelay(relayPort, '/_proxy/relay-status', `127.0.0.1:${relayPort}`, null);
    assert.equal(refusedAnswer.statusCode, 401);
    assert.equal((await getFromRelay(relayPort, '/_proxy/relay-status', 'attacker.example')).statusCode, 403);
  });

  test('answers 404 to every other request', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { relayPort } = await startRelay(fakeCentralService.url);
    assert.equal((await getFromRelay(relayPort, '/_proxy/api/requests')).statusCode, 404);
    assert.equal((await getFromRelay(relayPort, '/v1/messages')).statusCode, 404);
    assert.equal((await getFromRelay(relayPort, '/')).statusCode, 404);
  });

  test('refuses a request whose Host is not the relay on a loopback name', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { relayPort } = await startRelay(fakeCentralService.url);
    assert.equal((await getFromRelay(relayPort, '/_proxy/api/subscription-account-status', 'attacker.example')).statusCode, 403);
    assert.equal((await getFromRelay(relayPort, '/_proxy/api/subscription-account-status', `localhost:${relayPort}`)).statusCode, 200);
  });

  test('downloads the CA certificate at start', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo');
    const { claudeProxyRelay } = await startRelay(fakeCentralService.url);
    // `close()` waits for the start-up download.
    await claudeProxyRelay.close();
    assert.equal(fs.readFileSync(path.join(relayDirectory, 'certificate_authority.pem'), 'utf8'), certificateAuthorityPem);
    const certificateRequest = fakeCentralService.receivedRequests.find((receivedRequest) => receivedRequest.path === '/_proxy/certificate_authority.pem');
    assert.equal(certificateRequest?.headers['x-gateway-auth-token'], gatewayAuthToken);
    assert.deepEqual(fs.readdirSync(relayDirectory), ['certificate_authority.pem']);
  });

  test('keeps the CA certificate when the central service answers without a certificate', async () => {
    const loginPageServer = http.createServer((_, loginPageResponse) => loginPageResponse.writeHead(200, { 'content-type': 'text/html' }).end('<html>Log in</html>'));
    await new Promise<void>((resolve) => loginPageServer.listen(0, '127.0.0.1', resolve));
    closeAfterTest.push(() => new Promise<void>((resolve) => loginPageServer.close(() => resolve())));
    const { claudeProxyRelay } = await startRelay(new URL(`http://127.0.0.1:${(loginPageServer.address() as AddressInfo).port}`));
    await claudeProxyRelay.close();
    assert.equal(fs.readFileSync(path.join(relayDirectory, 'certificate_authority.pem'), 'utf8'), existingCertificateAuthorityPem);
  });

  test('starts and tunnels directly when the central service is down at start', async () => {
    const { relayPort, claudeProxyRelay } = await startRelay(await findClosedPortUrl());
    assert.ok(claudeProxyRelay.httpServer.listening);
    const { connectAnswer, tunnelAnswer } = await connectThroughRelay(relayPort, 'api.anthropic.com:443', 'client hello', 'anthropic:client hello');
    assert.equal(connectAnswer, 'HTTP/1.1 200 Connection Established\r\n\r\n');
    assert.equal(tunnelAnswer, 'anthropic:client hello');
    await claudeProxyRelay.close();
    assert.equal(fs.readFileSync(path.join(relayDirectory, 'certificate_authority.pem'), 'utf8'), existingCertificateAuthorityPem);
  });

  test('falls back to a direct tunnel when the central service answers 101 to another protocol', async () => {
    const fakeCentralService = await startCentral('switch_protocols_to_websocket');
    const { relayPort } = await startRelay(fakeCentralService.url);
    const { connectAnswer, tunnelAnswer } = await connectThroughRelay(relayPort, 'api.anthropic.com:443', 'client hello', 'anthropic:client hello');
    assert.equal(connectAnswer, 'HTTP/1.1 200 Connection Established\r\n\r\n');
    assert.equal(tunnelAnswer, 'anthropic:client hello');
    assert.ok(fakeCentralService.receivedRequests.some((receivedRequest) => receivedRequest.path === '/_proxy/tunnel'));
  });

  test('tunnels directly while it has no CA certificate, even when the central service answers 101', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo', Number.POSITIVE_INFINITY);
    const { relayPort } = await startRelay(fakeCentralService.url, { hasCertificateAuthorityFile: false });
    const { connectAnswer, tunnelAnswer } = await connectThroughRelay(relayPort, 'api.anthropic.com:443', 'client hello', 'anthropic:client hello');
    assert.equal(connectAnswer, 'HTTP/1.1 200 Connection Established\r\n\r\n');
    assert.equal(tunnelAnswer, 'anthropic:client hello');
    assert.equal(fakeCentralService.receivedRequests.filter((receivedRequest) => receivedRequest.path === '/_proxy/tunnel').length, 0);
  });

  test('retries a failed CA download, and then sends CONNECTs through the central tunnel', async () => {
    const fakeCentralService = await startCentral('switch_protocols_and_echo', 2);
    const { relayPort } = await startRelay(fakeCentralService.url, { hasCertificateAuthorityFile: false, certificateAuthorityDownloadRetryMilliseconds: 50 });
    const certificateAuthorityFilePath = path.join(relayDirectory, 'certificate_authority.pem');
    const waitDeadline = Date.now() + 2000;
    while (!fs.existsSync(certificateAuthorityFilePath) && Date.now() < waitDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.readFileSync(certificateAuthorityFilePath, 'utf8'), certificateAuthorityPem);
    assert.equal(fakeCentralService.receivedRequests.filter((receivedRequest) => receivedRequest.path === '/_proxy/certificate_authority.pem').length, 3);
    const { tunnelAnswer } = await connectThroughRelay(relayPort, 'api.anthropic.com:443', 'client hello', 'central:client hello');
    assert.equal(tunnelAnswer, 'central:client hello');
  });
});

describe('readClaudeProxyRelayConfiguration', () => {
  let relayDirectory: string;

  beforeEach(() => {
    relayDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude_proxy_relay_configuration_test_'));
  });

  afterEach(() => {
    fs.rmSync(relayDirectory, { recursive: true, force: true });
  });

  function writeRelayFile(fileName: string, fileContents: string, fileMode: number) {
    fs.writeFileSync(path.join(relayDirectory, fileName), fileContents);
    fs.chmodSync(path.join(relayDirectory, fileName), fileMode);
  }

  test('reads and trims the central URL and the Gateway Auth token', () => {
    writeRelayFile('central_url', ' https://claude-proxy.example.com\n', 0o600);
    writeRelayFile('gateway_auth_token', `${gatewayAuthToken}\n`, 0o600);
    const relayConfiguration = readClaudeProxyRelayConfiguration(relayDirectory);
    assert.equal(relayConfiguration.centralUrl.href, 'https://claude-proxy.example.com/');
    assert.equal(relayConfiguration.gatewayAuthToken, gatewayAuthToken);
  });

  test('writes the proxy credential once at first start, mode 600', () => {
    writeRelayFile('central_url', 'https://claude-proxy.example.com', 0o600);
    writeRelayFile('gateway_auth_token', gatewayAuthToken, 0o600);
    const relayProxyCredentialPath = path.join(relayDirectory, 'proxy_credential');
    const firstRelayConfiguration = readClaudeProxyRelayConfiguration(relayDirectory);
    assert.match(firstRelayConfiguration.relayProxyCredential, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fs.readFileSync(relayProxyCredentialPath, 'utf8').trim(), firstRelayConfiguration.relayProxyCredential);
    assert.equal(fs.statSync(relayProxyCredentialPath).mode & 0o777, 0o600);
    assert.equal(readClaudeProxyRelayConfiguration(relayDirectory).relayProxyCredential, firstRelayConfiguration.relayProxyCredential);

    fs.chmodSync(relayProxyCredentialPath, 0o644);
    assert.throws(
      () => readClaudeProxyRelayConfiguration(relayDirectory),
      (error: Error) =>
        error.message.includes(`refuses ${relayProxyCredentialPath}`) && !error.message.includes(firstRelayConfiguration.relayProxyCredential),
    );
  });

  test('refuses a missing file and names it', () => {
    writeRelayFile('gateway_auth_token', gatewayAuthToken, 0o600);
    assert.throws(() => readClaudeProxyRelayConfiguration(relayDirectory), new RegExp(path.join(relayDirectory, 'central_url')));
    fs.rmSync(path.join(relayDirectory, 'gateway_auth_token'));
    writeRelayFile('central_url', 'https://claude-proxy.example.com', 0o600);
    assert.throws(() => readClaudeProxyRelayConfiguration(relayDirectory), new RegExp(path.join(relayDirectory, 'gateway_auth_token')));
  });

  test('refuses a Gateway Auth token that the group or others can read, and names the file', () => {
    writeRelayFile('central_url', 'https://claude-proxy.example.com', 0o600);
    writeRelayFile('gateway_auth_token', gatewayAuthToken, 0o640);
    assert.throws(
      () => readClaudeProxyRelayConfiguration(relayDirectory),
      (error: Error) => error.message.includes(path.join(relayDirectory, 'gateway_auth_token')) && !error.message.includes(gatewayAuthToken),
    );
  });

  test('refuses a central URL file that the group or others can read, and names the file', () => {
    writeRelayFile('central_url', 'https://claude-proxy.example.com', 0o644);
    writeRelayFile('gateway_auth_token', gatewayAuthToken, 0o600);
    assert.throws(() => readClaudeProxyRelayConfiguration(relayDirectory), (error: Error) => error.message.includes(`refuses ${path.join(relayDirectory, 'central_url')}`));
  });

  test('refuses a central URL that is not http or https', () => {
    writeRelayFile('central_url', 'ftp://claude-proxy.example.com', 0o600);
    writeRelayFile('gateway_auth_token', gatewayAuthToken, 0o600);
    assert.throws(() => readClaudeProxyRelayConfiguration(relayDirectory), /central_url/);
  });
});
