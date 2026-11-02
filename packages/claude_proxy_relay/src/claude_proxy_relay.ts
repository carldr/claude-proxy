import fs from 'node:fs';
import http, { type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';

/** The only CONNECT target that the relay sends through the central claude-proxy. The relay tunnels every other target from this machine. */
export const relayedAnthropicApiConnectTarget = 'api.anthropic.com:443';

/** The path of the central claude-proxy's tunnel endpoint. It has the value of `claudeProxyTunnelPath` in the server package. */
export const claudeProxyTunnelPath = '/_proxy/tunnel';
/** The `Upgrade` header value of the tunnel endpoint. It has the value of `claudeProxyTunnelUpgradeToken` in the server package. */
export const claudeProxyTunnelUpgradeToken = 'claude-proxy-tunnel';

/** The menu bar app reads this path from the relay, and the relay reads it from the central claude-proxy. */
export const subscriptionAccountStatusPath = '/_proxy/api/subscription-account-status';
/** The central claude-proxy serves the public certificate of its certificate authority at this path. */
export const certificateAuthorityPath = '/_proxy/certificate_authority.pem';
/** The file in the relay directory that holds the central certificate authority. Claude Code reads it through `NODE_EXTRA_CA_CERTS`. */
export const certificateAuthorityFileName = 'certificate_authority.pem';

/** How long the relay waits for the central claude-proxy's status or certificate answer. */
const centralRequestTimeoutMilliseconds = 10_000;
/** The relay logs at most one fallback to a direct tunnel in this time, so a central outage does not fill the log. */
const fallbackLogIntervalMilliseconds = 60_000;
/** The largest certificate authority file that the relay accepts. A real certificate is about 1 KB. */
const certificateAuthorityMaximumBytes = 64 * 1024;

const connectAcceptedResponseHead = 'HTTP/1.1 200 Connection Established\r\n\r\n';

export interface ClaudeProxyRelayOptions {
  /** The central claude-proxy behind Caddy and Gateway Auth, with an `http:` or `https:` scheme. */
  centralUrl: URL;
  /** Sent as `X-Gateway-Auth-Token` on every request to the central claude-proxy. The relay never logs it. */
  gatewayAuthToken: string;
  /** Holds `central_url`, `gateway_auth_token` and the downloaded `certificate_authority.pem`. */
  relayDirectory: string;
  /** The host and port of the direct tunnel when the central claude-proxy fails: `api.anthropic.com:443` outside tests. */
  anthropicApiHost: string;
  anthropicApiPort: number;
  /** How long the relay waits for the central claude-proxy's 101 before it tunnels directly. */
  tunnelUpgradeTimeoutMilliseconds: number;
}

export interface ClaudeProxyRelay {
  httpServer: Server;
  /** Destroys the open tunnels, stops the server and waits for the start-up certificate download. */
  close(): Promise<void>;
}

/** The contents of `central_url` and `gateway_auth_token` in the relay directory. */
export interface ClaudeProxyRelayConfiguration {
  centralUrl: URL;
  gatewayAuthToken: string;
}

/**
 * Reads `central_url` and `gateway_auth_token` from `relayDirectory` and trims them. It throws, and names the file,
 * when a file is missing or empty, when the URL is not `http:` or `https:`, or when the group or others can read the token.
 */
export function readClaudeProxyRelayConfiguration(relayDirectory: string): ClaudeProxyRelayConfiguration {
  const centralUrlPath = path.join(relayDirectory, 'central_url');
  const gatewayAuthTokenPath = path.join(relayDirectory, 'gateway_auth_token');
  const readRequiredFile = (requiredFilePath: string) => {
    let fileContents: string;
    try {
      fileContents = fs.readFileSync(requiredFilePath, 'utf8').trim();
    } catch (error) {
      throw new Error(`claude-proxy-relay cannot read ${requiredFilePath}: ${(error as Error).message}`);
    }
    if (fileContents === '') throw new Error(`claude-proxy-relay found ${requiredFilePath} empty.`);
    return fileContents;
  };
  const centralUrlText = readRequiredFile(centralUrlPath);
  const centralUrl = URL.parse(centralUrlText);
  if (!centralUrl || (centralUrl.protocol !== 'http:' && centralUrl.protocol !== 'https:')) {
    throw new Error(`claude-proxy-relay needs an http: or https: URL in ${centralUrlPath}.`);
  }
  const gatewayAuthToken = readRequiredFile(gatewayAuthTokenPath);
  if ((fs.statSync(gatewayAuthTokenPath).mode & 0o077) !== 0) {
    throw new Error(`claude-proxy-relay refuses ${gatewayAuthTokenPath}, because the group or others can read it. Run: chmod 600 ${gatewayAuthTokenPath}`);
  }
  return { centralUrl, gatewayAuthToken };
}

/** Returns true for an address in 127.0.0.0/8, for `::1`, and for an IPv4-mapped address in 127.0.0.0/8. */
function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false;
  if (remoteAddress === '::1') return true;
  const ipv4Address = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress;
  return net.isIPv4(ipv4Address) && ipv4Address.startsWith('127.');
}

/**
 * Accepts a request only from a loopback connection, with the Host 127.0.0.1 or localhost on the relay's port,
 * and with no Origin or the relay's own Origin. This stops web pages, including pages that use DNS rebinding, from using the relay.
 */
function isAcceptedRelayRequest(clientRequest: IncomingMessage, httpServer: Server): boolean {
  const relayPort = (httpServer.address() as AddressInfo).port;
  const localHosts = [`127.0.0.1:${relayPort}`, `localhost:${relayPort}`];
  const origin = clientRequest.headers.origin;
  if (!localHosts.includes(clientRequest.headers.host ?? '')) return false;
  if (!isLoopbackAddress(clientRequest.socket.remoteAddress)) return false;
  return origin === undefined || localHosts.some((localHost) => origin === `http://${localHost}`);
}

/**
 * Creates the relay, which Claude Code uses as its `HTTPS_PROXY`. It sends each api.anthropic.com CONNECT through the central
 * claude-proxy's tunnel endpoint. When the central claude-proxy fails, it tunnels to api.anthropic.com directly.
 * The caller calls `listen` on `httpServer`.
 */
export function createClaudeProxyRelay(options: ClaudeProxyRelayOptions): ClaudeProxyRelay {
  const centralRequest = options.centralUrl.protocol === 'https:' ? https.request : http.request;
  const centralRequestHeaders = { host: options.centralUrl.host, 'x-gateway-auth-token': options.gatewayAuthToken };

  const openSockets = new Set<Duplex>();
  const trackOpenSocket = (openSocket: Duplex) => {
    openSockets.add(openSocket);
    openSocket.on('close', () => openSockets.delete(openSocket));
  };

  let lastFallbackLoggedAt = Number.NEGATIVE_INFINITY;
  const logFallback = (fallbackReason: string) => {
    if (Date.now() - lastFallbackLoggedAt < fallbackLogIntervalMilliseconds) return;
    lastFallbackLoggedAt = Date.now();
    console.error(`claude-proxy-relay tunnels ${relayedAnthropicApiConnectTarget} directly, because ${fallbackReason}.`);
  };

  /** Connects `clientSocket` to `targetHost:targetPort` from this machine, and answers 502 when the target cannot be reached. */
  const tunnelConnection = (targetHost: string, targetPort: number, clientSocket: Duplex) => {
    let isTunnelOpen = false;
    const upstreamSocket = net.connect(targetPort, targetHost, () => {
      isTunnelOpen = true;
      clientSocket.write(connectAcceptedResponseHead);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    trackOpenSocket(upstreamSocket);
    upstreamSocket.on('error', (error) => {
      if (isTunnelOpen) clientSocket.destroy();
      else clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\nclaude-proxy-relay could not reach ${targetHost}:${targetPort}: ${error.message}\n`);
    });
    upstreamSocket.on('close', () => {
      if (isTunnelOpen) clientSocket.destroy();
    });
    clientSocket.on('close', () => upstreamSocket.destroy());
  };

  /** Opens the central tunnel for `clientSocket`. A response other than 101, an error or the timeout gives a direct tunnel. */
  const relayAnthropicApiConnection = (clientSocket: Duplex) => {
    let isSettled = false;
    const tunnelUpgradeRequest: ClientRequest = centralRequest(new URL(claudeProxyTunnelPath, options.centralUrl), {
      method: 'GET',
      agent: false,
      headers: { ...centralRequestHeaders, connection: 'Upgrade', upgrade: claudeProxyTunnelUpgradeToken },
    });
    const tunnelDirectly = (fallbackReason: string) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(tunnelUpgradeTimer);
      tunnelUpgradeRequest.destroy();
      if (clientSocket.destroyed) return;
      logFallback(fallbackReason);
      tunnelConnection(options.anthropicApiHost, options.anthropicApiPort, clientSocket);
    };
    const tunnelUpgradeTimer = setTimeout(
      () => tunnelDirectly(`the central claude-proxy did not answer within ${options.tunnelUpgradeTimeoutMilliseconds} ms`),
      options.tunnelUpgradeTimeoutMilliseconds,
    );
    tunnelUpgradeRequest.on('upgrade', (upgradeResponse: IncomingMessage, centralSocket: Duplex, centralSocketHead: Buffer) => {
      trackOpenSocket(centralSocket);
      centralSocket.on('error', () => centralSocket.destroy());
      if (isSettled || clientSocket.destroyed) {
        centralSocket.destroy();
        return;
      }
      if (upgradeResponse.statusCode !== 101) {
        centralSocket.destroy();
        tunnelDirectly(`the central claude-proxy answered ${upgradeResponse.statusCode}`);
        return;
      }
      isSettled = true;
      clearTimeout(tunnelUpgradeTimer);
      clientSocket.write(connectAcceptedResponseHead);
      if (centralSocketHead.length > 0) clientSocket.write(centralSocketHead);
      centralSocket.pipe(clientSocket);
      clientSocket.pipe(centralSocket);
      centralSocket.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => centralSocket.destroy());
    });
    tunnelUpgradeRequest.on('response', (refusalResponse: IncomingMessage) => {
      refusalResponse.resume();
      tunnelDirectly(`the central claude-proxy answered ${refusalResponse.statusCode}`);
    });
    tunnelUpgradeRequest.on('error', (error) => tunnelDirectly(`the central claude-proxy failed: ${error.message}`));
    clientSocket.on('close', () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(tunnelUpgradeTimer);
      tunnelUpgradeRequest.destroy();
    });
    tunnelUpgradeRequest.end();
  };

  /** Sends a GET for `centralPath` to the central claude-proxy and resolves with the status and the body, up to `maximumBodyBytes`. */
  const getFromCentral = (centralPath: string, maximumBodyBytes: number) =>
    new Promise<{ statusCode: number; contentType: string | undefined; body: Buffer }>((resolve, reject) => {
      const centralGetRequest = centralRequest(new URL(centralPath, options.centralUrl), {
        method: 'GET',
        agent: false,
        headers: centralRequestHeaders,
        timeout: centralRequestTimeoutMilliseconds,
      });
      centralGetRequest.on('timeout', () => centralGetRequest.destroy(new Error(`no answer within ${centralRequestTimeoutMilliseconds} ms`)));
      centralGetRequest.on('error', reject);
      centralGetRequest.on('response', (centralResponse: IncomingMessage) => {
        const bodyChunks: Buffer[] = [];
        let bodyByteCount = 0;
        centralResponse.on('data', (bodyChunk: Buffer) => {
          bodyByteCount += bodyChunk.length;
          if (bodyByteCount > maximumBodyBytes) centralGetRequest.destroy(new Error(`the answer is larger than ${maximumBodyBytes} bytes`));
          else bodyChunks.push(bodyChunk);
        });
        centralResponse.on('error', reject);
        centralResponse.on('end', () =>
          resolve({ statusCode: centralResponse.statusCode ?? 0, contentType: centralResponse.headers['content-type'], body: Buffer.concat(bodyChunks) }),
        );
      });
      centralGetRequest.end();
    });

  const forwardSubscriptionAccountStatus = (clientResponse: ServerResponse) => {
    getFromCentral(subscriptionAccountStatusPath, 16 * 1024 * 1024)
      .then((centralAnswer) => {
        if (centralAnswer.statusCode !== 200) {
          clientResponse.writeHead(502, { 'content-type': 'text/plain' }).end(`The central claude-proxy answered ${centralAnswer.statusCode}.\n`);
          return;
        }
        clientResponse.writeHead(200, { 'content-type': centralAnswer.contentType ?? 'application/json' }).end(centralAnswer.body);
      })
      .catch((error: Error) => {
        clientResponse.writeHead(502, { 'content-type': 'text/plain' }).end(`claude-proxy-relay could not reach the central claude-proxy: ${error.message}\n`);
      });
  };

  /** Writes the central certificate authority to the relay directory. Any other answer keeps the existing file. */
  const downloadCertificateAuthority = async () => {
    const certificateAuthorityFilePath = path.join(options.relayDirectory, certificateAuthorityFileName);
    try {
      const centralAnswer = await getFromCentral(certificateAuthorityPath, certificateAuthorityMaximumBytes);
      const certificateAuthorityPem = centralAnswer.body.toString('utf8');
      if (centralAnswer.statusCode !== 200 || !certificateAuthorityPem.startsWith('-----BEGIN CERTIFICATE-----')) {
        console.error(`claude-proxy-relay keeps ${certificateAuthorityFilePath}, because the central claude-proxy answered ${centralAnswer.statusCode} without a certificate.`);
        return;
      }
      const temporaryFilePath = `${certificateAuthorityFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryFilePath, certificateAuthorityPem);
      fs.renameSync(temporaryFilePath, certificateAuthorityFilePath);
    } catch (error) {
      console.error(`claude-proxy-relay keeps ${certificateAuthorityFilePath}, because the certificate download failed: ${(error as Error).message}`);
    }
  };

  const httpServer = http.createServer((clientRequest, clientResponse) => {
    if (!isAcceptedRelayRequest(clientRequest, httpServer)) {
      clientResponse.writeHead(403, { 'content-type': 'text/plain' }).end('claude-proxy-relay does not accept requests addressed to this host name.\n');
    } else if (clientRequest.method === 'GET' && (clientRequest.url ?? '').split('?')[0] === subscriptionAccountStatusPath) {
      forwardSubscriptionAccountStatus(clientResponse);
    } else {
      clientResponse.writeHead(404, { 'content-type': 'text/plain' }).end(`claude-proxy-relay serves only ${subscriptionAccountStatusPath} and CONNECT.\n`);
    }
  });

  httpServer.on('connect', (connectRequest: IncomingMessage, clientSocket: Duplex, connectRequestHead: Buffer) => {
    trackOpenSocket(clientSocket);
    // Node removes its own error listener before it emits `connect`. Without this one, a reset crashes the relay.
    clientSocket.on('error', () => clientSocket.destroy());
    // A CONNECT carries the target in its Host, so the relay checks only the connection. A web page cannot send CONNECT.
    if (!isLoopbackAddress(connectRequest.socket.remoteAddress)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    if (connectRequestHead.length > 0) clientSocket.unshift(connectRequestHead);
    const connectTarget = connectRequest.url ?? '';
    if (connectTarget === relayedAnthropicApiConnectTarget) {
      relayAnthropicApiConnection(clientSocket);
      return;
    }
    const targetUrl = URL.parse(`http://${connectTarget}`);
    if (!targetUrl || targetUrl.port === '') {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
      return;
    }
    tunnelConnection(targetUrl.hostname.replace(/^\[(.*)\]$/, '$1'), Number(targetUrl.port), clientSocket);
  });

  const certificateAuthorityDownload = downloadCertificateAuthority();
  let relayClosing: Promise<void> | null = null;

  return {
    httpServer,
    close() {
      relayClosing ??= (async () => {
        httpServer.closeAllConnections();
        for (const openSocket of openSockets) openSocket.destroy();
        if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await certificateAuthorityDownload;
      })();
      return relayClosing;
    },
  };
}
