import crypto from 'node:crypto';
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
/** The relay answers this path itself, with no request to the central claude-proxy. The launch check of a shell function reads it. */
export const relayStatusPath = '/_proxy/relay-status';
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

/** The file in the relay directory that holds the proxy credential. The relay writes it once, with mode 600. */
export const relayProxyCredentialFileName = 'proxy_credential';
/** The user name that a client sends with the proxy credential, in `Basic` credentials. */
export const relayProxyCredentialUserName = 'relay';
/** The realm in the relay's `Proxy-Authenticate` and `WWW-Authenticate` headers. */
const relayProxyCredentialRealm = 'claude-proxy-relay';
const connectRefusedResponseHead =
  `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${relayProxyCredentialRealm}"\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`;

export interface ClaudeProxyRelayOptions {
  /** The central claude-proxy behind Caddy and Gateway Auth, with an `http:` or `https:` scheme. */
  centralUrl: URL;
  /** Sent as `X-Gateway-Auth-Token` on every request to the central claude-proxy. The relay never logs it. */
  gatewayAuthToken: string;
  /**
   * Every client sends this credential with the user name `relay`, so that another Unix user on this machine cannot use the relay.
   * The relay never logs it.
   */
  relayProxyCredential: string;
  /** Holds `central_url`, `gateway_auth_token`, `proxy_credential` and the downloaded `certificate_authority.pem`. */
  relayDirectory: string;
  /** The host and port of the direct tunnel when the central claude-proxy fails: `api.anthropic.com:443` outside tests. */
  anthropicApiHost: string;
  anthropicApiPort: number;
  /** How long the relay waits for the central claude-proxy's 101 before it tunnels directly. */
  tunnelUpgradeTimeoutMilliseconds: number;
  /** How long the relay waits before it downloads the certificate authority again, while `certificate_authority.pem` is missing. */
  certificateAuthorityDownloadRetryMilliseconds: number;
}

export interface ClaudeProxyRelay {
  httpServer: Server;
  /** Destroys the open tunnels, stops the server and the certificate download retries, and waits for a running download. */
  close(): Promise<void>;
}

/** The contents of `central_url`, `gateway_auth_token` and `proxy_credential` in the relay directory. */
export interface ClaudeProxyRelayConfiguration {
  centralUrl: URL;
  gatewayAuthToken: string;
  relayProxyCredential: string;
}

/**
 * Reads `central_url`, `gateway_auth_token` and `proxy_credential` from `relayDirectory` and trims them. It first writes
 * `proxy_credential` with 32 random bytes when the file does not exist. It throws, and names the file, when a file is missing
 * or empty, when the URL is not `http:` or `https:`, or when the group or others can read a file.
 */
export function readClaudeProxyRelayConfiguration(relayDirectory: string): ClaudeProxyRelayConfiguration {
  const centralUrlPath = path.join(relayDirectory, 'central_url');
  const gatewayAuthTokenPath = path.join(relayDirectory, 'gateway_auth_token');
  const relayProxyCredentialPath = path.join(relayDirectory, relayProxyCredentialFileName);
  const readRequiredFile = (requiredFilePath: string) => {
    let fileContents: string;
    let fileMode: number;
    try {
      fileContents = fs.readFileSync(requiredFilePath, 'utf8').trim();
      fileMode = fs.statSync(requiredFilePath).mode;
    } catch (error) {
      throw new Error(`claude-proxy-relay cannot read ${requiredFilePath}: ${(error as Error).message}`);
    }
    if ((fileMode & 0o077) !== 0) {
      throw new Error(`claude-proxy-relay refuses ${requiredFilePath}, because the group or others can read it. Run: chmod 600 ${requiredFilePath}`);
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
  createRelayProxyCredentialFile(relayProxyCredentialPath);
  const relayProxyCredential = readRequiredFile(relayProxyCredentialPath);
  return { centralUrl, gatewayAuthToken, relayProxyCredential };
}

/** Writes 32 random bytes as base64url to `relayProxyCredentialPath`, with mode 600. The exclusive create never replaces an existing file. */
function createRelayProxyCredentialFile(relayProxyCredentialPath: string) {
  let relayProxyCredentialFileDescriptor: number;
  try {
    relayProxyCredentialFileDescriptor = fs.openSync(relayProxyCredentialPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw new Error(`claude-proxy-relay cannot create ${relayProxyCredentialPath}: ${(error as Error).message}`);
  }
  try {
    fs.writeFileSync(relayProxyCredentialFileDescriptor, `${crypto.randomBytes(32).toString('base64url')}\n`);
  } finally {
    fs.closeSync(relayProxyCredentialFileDescriptor);
  }
}

/** Compares the SHA-256 digests of two strings with `timingSafeEqual`, so the time does not show where they differ, or their lengths. */
function isTimingSafeEqualText(receivedText: string, expectedText: string): boolean {
  const sha256Digest = (digestedText: string) => crypto.createHash('sha256').update(digestedText, 'utf8').digest();
  return crypto.timingSafeEqual(sha256Digest(receivedText), sha256Digest(expectedText));
}

/**
 * Returns true when `authorizationHeader` holds `Basic` credentials, with any case of the scheme, for the user `relay` and
 * `relayProxyCredential`. The relay reads `Proxy-Authorization` on a CONNECT and `Authorization` on another request.
 */
function hasRelayProxyCredential(authorizationHeader: string | undefined, relayProxyCredential: string): boolean {
  const basicCredentialsMatch = /^basic\s+(\S+)\s*$/i.exec(authorizationHeader ?? '');
  if (!basicCredentialsMatch) return false;
  const credentialPair = Buffer.from(basicCredentialsMatch[1], 'base64').toString('utf8');
  const separatorIndex = credentialPair.indexOf(':');
  if (separatorIndex === -1) return false;
  const isUserNameEqual = isTimingSafeEqualText(credentialPair.slice(0, separatorIndex), relayProxyCredentialUserName);
  const isCredentialEqual = isTimingSafeEqualText(credentialPair.slice(separatorIndex + 1), relayProxyCredential);
  return isUserNameEqual && isCredentialEqual;
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
      // A 101 to another protocol comes from a server that is not claude-proxy, and must not get Claude Code's TLS bytes.
      if (upgradeResponse.headers.upgrade?.toLowerCase() !== claudeProxyTunnelUpgradeToken) {
        centralSocket.destroy();
        tunnelDirectly(`the central claude-proxy answered 101 with Upgrade: ${upgradeResponse.headers.upgrade ?? '(none)'}`);
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

  const certificateAuthorityFilePath = path.join(options.relayDirectory, certificateAuthorityFileName);

  /** Writes the central certificate authority to the relay directory. Any other answer keeps the existing file. */
  const downloadCertificateAuthority = async () => {
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
    } else if (!hasRelayProxyCredential(clientRequest.headers.authorization, options.relayProxyCredential)) {
      clientResponse
        .writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': `Basic realm="${relayProxyCredentialRealm}"` })
        .end(`claude-proxy-relay needs the user ${relayProxyCredentialUserName} and the credential in ${relayProxyCredentialFileName}.\n`);
    } else if (clientRequest.method === 'GET' && (clientRequest.url ?? '').split('?')[0] === subscriptionAccountStatusPath) {
      forwardSubscriptionAccountStatus(clientResponse);
    } else if (clientRequest.method === 'GET' && (clientRequest.url ?? '').split('?')[0] === relayStatusPath) {
      clientResponse.writeHead(200, { 'content-type': 'application/json' }).end('{"relay":"ok"}');
    } else {
      clientResponse.writeHead(404, { 'content-type': 'text/plain' }).end(`claude-proxy-relay serves only ${subscriptionAccountStatusPath}, ${relayStatusPath} and CONNECT.\n`);
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
    // Another Unix user on this machine also connects from a loopback address, so every CONNECT needs the proxy credential.
    if (!hasRelayProxyCredential(connectRequest.headers['proxy-authorization'], options.relayProxyCredential)) {
      clientSocket.end(connectRefusedResponseHead);
      return;
    }
    if (connectRequestHead.length > 0) clientSocket.unshift(connectRequestHead);
    const connectTarget = connectRequest.url ?? '';
    if (connectTarget === relayedAnthropicApiConnectTarget) {
      // Claude Code trusts the central claude-proxy only through this file, so without it a central tunnel fails TLS.
      if (fs.existsSync(certificateAuthorityFilePath)) {
        relayAnthropicApiConnection(clientSocket);
      } else {
        logFallback(`${certificateAuthorityFilePath} does not exist yet`);
        tunnelConnection(options.anthropicApiHost, options.anthropicApiPort, clientSocket);
      }
      return;
    }
    const targetUrl = URL.parse(`http://${connectTarget}`);
    if (!targetUrl || targetUrl.port === '') {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
      return;
    }
    tunnelConnection(targetUrl.hostname.replace(/^\[(.*)\]$/, '$1'), Number(targetUrl.port), clientSocket);
  });

  let isRelayClosing = false;
  let certificateAuthorityDownloadRetryTimer: NodeJS.Timeout | undefined;
  let certificateAuthorityDownload: Promise<void> = Promise.resolve();
  /** Downloads the certificate authority, and again after `certificateAuthorityDownloadRetryMilliseconds` while the file is missing. */
  const downloadCertificateAuthorityUntilPresent = () => {
    certificateAuthorityDownload = downloadCertificateAuthority().then(() => {
      if (isRelayClosing || fs.existsSync(certificateAuthorityFilePath)) return;
      certificateAuthorityDownloadRetryTimer = setTimeout(downloadCertificateAuthorityUntilPresent, options.certificateAuthorityDownloadRetryMilliseconds);
      certificateAuthorityDownloadRetryTimer.unref();
    });
  };
  downloadCertificateAuthorityUntilPresent();
  let relayClosing: Promise<void> | null = null;

  return {
    httpServer,
    close() {
      relayClosing ??= (async () => {
        isRelayClosing = true;
        clearTimeout(certificateAuthorityDownloadRetryTimer);
        httpServer.closeAllConnections();
        for (const openSocket of openSockets) openSocket.destroy();
        if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await certificateAuthorityDownload;
      })();
      return relayClosing;
    },
  };
}
