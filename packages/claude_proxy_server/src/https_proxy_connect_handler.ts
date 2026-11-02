import fs from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';

/**
 * The only CONNECT target that the proxy decrypts. Claude Code enables Remote Control and on-demand tool loading
 * only when its API host is api.anthropic.com, so it reaches the proxy through `HTTPS_PROXY` instead of
 * `ANTHROPIC_BASE_URL`. The proxy tunnels every other CONNECT target unchanged.
 */
export const interceptedAnthropicApiConnectTarget = 'api.anthropic.com:443';

/** The path of the HTTP upgrade that carries a decrypted api.anthropic.com connection, for clients that cannot send CONNECT. */
export const claudeProxyTunnelPath = '/_proxy/tunnel';
/** The `Upgrade` header value of the tunnel endpoint. */
export const claudeProxyTunnelUpgradeToken = 'claude-proxy-tunnel';

const connectAcceptedResponseHead = 'HTTP/1.1 200 Connection Established\r\n\r\n';
const tunnelAcceptedResponseHead = `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${claudeProxyTunnelUpgradeToken}\r\n\r\n`;

export interface HttpsProxyConnectHandlerOptions {
  /** A certificate for api.anthropic.com, from `scripts/create_certificate_authority.sh`. Claude Code trusts its certificate authority through `NODE_EXTRA_CA_CERTS`. */
  anthropicApiCertificatePath: string;
  anthropicApiCertificateKeyPath: string;
  /** Receives the decrypted api.anthropic.com connections. It does not listen on a port. */
  interceptedAnthropicApiServer: Server;
  /** Receives every client socket, so that `close()` can destroy the open tunnels. */
  trackClientSocket: (clientSocket: Duplex) => void;
}

/** Answers one `CONNECT` request from a client that uses the proxy as its `HTTPS_PROXY`. */
export function handleHttpsProxyConnect(
  connectRequest: IncomingMessage,
  clientSocket: Duplex,
  connectRequestHead: Buffer,
  options: HttpsProxyConnectHandlerOptions,
): void {
  options.trackClientSocket(clientSocket);
  // Node removes its own error listener before it emits `connect`. Without this one, a reset crashes the proxy.
  clientSocket.on('error', () => clientSocket.destroy());
  if (connectRequestHead.length > 0) clientSocket.unshift(connectRequestHead);
  const connectTarget = connectRequest.url ?? '';
  if (connectTarget === interceptedAnthropicApiConnectTarget) decryptAnthropicApiConnection(clientSocket, connectAcceptedResponseHead, options);
  else tunnelConnection(connectTarget, clientSocket);
}

/** Answers one upgrade request on the tunnel endpoint. The caller has checked the host, the path and the upgrade token. */
export function handleClaudeProxyTunnelUpgrade(
  upgradeRequestHead: Buffer,
  clientSocket: Duplex,
  options: HttpsProxyConnectHandlerOptions,
): void {
  options.trackClientSocket(clientSocket);
  // Node removes its own error listener before it emits `upgrade`. Without this one, a reset crashes the proxy.
  clientSocket.on('error', () => clientSocket.destroy());
  if (upgradeRequestHead.length > 0) clientSocket.unshift(upgradeRequestHead);
  decryptAnthropicApiConnection(clientSocket, tunnelAcceptedResponseHead, options);
}

/**
 * Writes `acceptedResponseHead` to the client, then decrypts the connection as api.anthropic.com.
 * The `CONNECT` path and the tunnel endpoint share it.
 */
export function decryptAnthropicApiConnection(
  clientSocket: Duplex,
  acceptedResponseHead: string,
  options: HttpsProxyConnectHandlerOptions,
): void {
  let secureContext: tls.SecureContext;
  try {
    secureContext = tls.createSecureContext({
      cert: fs.readFileSync(options.anthropicApiCertificatePath),
      key: fs.readFileSync(options.anthropicApiCertificateKeyPath),
    });
  } catch (error) {
    const errorMessage =
      `claude-proxy has no certificate for api.anthropic.com (${(error as Error).message}). ` +
      `Run: sh scripts/create_certificate_authority.sh ${path.dirname(options.anthropicApiCertificatePath)}`;
    console.error(errorMessage);
    clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${errorMessage}\n`);
    return;
  }
  clientSocket.write(acceptedResponseHead);
  const decryptedSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
  options.interceptedAnthropicApiServer.emit('connection', decryptedSocket);
}

function tunnelConnection(connectTarget: string, clientSocket: Duplex): void {
  const targetUrl = URL.parse(`http://${connectTarget}`);
  if (!targetUrl || targetUrl.port === '') {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    return;
  }
  const targetHostname = targetUrl.hostname.replace(/^\[(.*)\]$/, '$1');
  let isTunnelOpen = false;
  const upstreamSocket = net.connect(Number(targetUrl.port), targetHostname, () => {
    isTunnelOpen = true;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
  upstreamSocket.on('error', (error) => {
    if (isTunnelOpen) clientSocket.destroy();
    else clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\nclaude-proxy could not reach ${connectTarget}: ${error.message}\n`);
  });
  clientSocket.on('close', () => upstreamSocket.destroy());
}
