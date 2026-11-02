import fs from 'node:fs';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { claudeProxyTunnelPath, claudeProxyTunnelUpgradeToken, handleClaudeProxyTunnelUpgrade, handleHttpsProxyConnect } from './https_proxy_connect_handler.ts';
import { parseModelPricingConfig, type ModelPricingTable } from './model_pricing_config.ts';
import { handleProxyRequest } from './proxy_request_handler.ts';
import { RequestDatabase } from './request_database.ts';
import { SubscriptionAccountLoginHandler } from './subscription_account_login_handler.ts';
import { SubscriptionAccountGrantRefresher, type OAuthEndpoints } from './subscription_account_oauth.ts';
import { SubscriptionAccountRouter } from './subscription_account_router.ts';
import { SubscriptionAccountStore } from './subscription_account_store.ts';
import { SubscriptionAccountUsageMonitor } from './subscription_account_usage_monitor.ts';
import {
  emptySubscriptionAccountsConfig,
  parseSubscriptionAccountsConfig,
  type SubscriptionAccountsConfig,
} from './subscription_accounts_config.ts';
import { handleWebApiRequest, webApiPathPrefix } from './web_api_handler.ts';
import { handleWebUiStaticFileRequest, webUiPathPrefix } from './web_ui_static_file_handler.ts';
import { YamlConfigFile } from './yaml_config_file.ts';

export interface ClaudeProxyServerOptions {
  /**
   * Holds `subscription_accounts.yml`, `pricing.yml`, `requests.sqlite`, and the api.anthropic.com certificate
   * `api.anthropic.com.pem` with its key `api.anthropic.com-key.pem`. Normally `~/.claude-proxy`.
   */
  claudeProxyDirectory: string;
  anthropicBaseUrl: string;
  /** The OAuth endpoints that refresh the subscription account grants, normally `anthropicOAuthEndpoints`. */
  oauthEndpoints: OAuthEndpoints;
  webUiDistDirectory: string;
  claudeCodeProjectsDirectory: string;
  /**
   * The public host name of a central install, such as `claude-proxy.example.com`, or null for a local install.
   * Caddy terminates TLS for this name. When it is set, the proxy refuses every CONNECT.
   */
  publicHostname: string | null;
}

export interface ClaudeProxyServer {
  httpServer: Server;
  requestDatabase: RequestDatabase;
  subscriptionAccountStore: SubscriptionAccountStore;
  subscriptionAccountRouter: SubscriptionAccountRouter;
  subscriptionAccountUsageMonitor: SubscriptionAccountUsageMonitor;
  close(): Promise<void>;
}

const defaultConfigDirectory = path.join(import.meta.dirname, '..', 'default_config');

/**
 * On the loopback listener, the proxy forwards and records only these paths. Other paths, such as a browser
 * tab left on port 4100, get a local 404 and are not recorded. Intercepted api.anthropic.com connections
 * forward every path, because Claude Code also uses others there, such as `/mcp-registry/`.
 */
const anthropicApiPathPrefixes = ['/v1/', '/api/'];

/**
 * After this many days, the proxy deletes the headers, bodies and search text of a request, at start and then once a day.
 * The tokens, the cost, the session and the project of the request stay.
 */
const requestContentsRetentionDays = 365;

/**
 * Accepts a request only when its Host is 127.0.0.1 or localhost on the proxy's port, and when it has no Origin
 * or the proxy's own Origin. When `publicHostname` is set, it also accepts that Host without a port, with no Origin
 * or the Origin `https://<publicHostname>`. This stops web pages, including pages that use DNS rebinding, from reading recorded
 * requests or from sending requests that the proxy would send with a subscription account's grant. Claude Code sends no Origin header.
 */
function isAcceptedRequest(clientRequest: IncomingMessage, httpServer: Server, publicHostname: string | null): boolean {
  const proxyPort = (httpServer.address() as AddressInfo).port;
  const localHosts = [`127.0.0.1:${proxyPort}`, `localhost:${proxyPort}`];
  const origin = clientRequest.headers.origin;
  const requestHost = clientRequest.headers.host ?? '';
  if (localHosts.includes(requestHost)) return origin === undefined || localHosts.some((localHost) => origin === `http://${localHost}`);
  return publicHostname !== null && requestHost === publicHostname && (origin === undefined || origin === `https://${publicHostname}`);
}

/** The file system calls of `makeClaudeProxyFilePrivate`. Tests replace them. */
export interface ClaudeProxyFileModeOperations {
  statSync: (filePath: string) => { uid: number };
  chmodSync: (filePath: string, fileMode: number) => void;
}

/**
 * Sets the mode of the proxy directory or of a file in it. `requests.sqlite` holds the refresh tokens of the subscription
 * accounts, so the function throws when another user owns the path or when the mode does not change.
 */
export function makeClaudeProxyFilePrivate(
  claudeProxyDirectory: string,
  filePath: string,
  fileMode: number,
  fileModeOperations: ClaudeProxyFileModeOperations = fs,
  currentUid: number = process.getuid!(),
): void {
  const ownershipFix = `Fix the ownership with: sudo chown -R $(id -un) ${claudeProxyDirectory}`;
  const ownerUid = fileModeOperations.statSync(filePath).uid;
  if (ownerUid !== currentUid) {
    throw new Error(
      `claude-proxy does not start: uid ${ownerUid} owns ${filePath}, but the proxy runs as uid ${currentUid}, ` +
        `so another user could read the refresh tokens. ${ownershipFix}`,
    );
  }
  try {
    fileModeOperations.chmodSync(filePath, fileMode);
  } catch (error) {
    throw new Error(
      `claude-proxy does not start: it could not set the mode of ${filePath} to ${fileMode.toString(8)} ` +
        `(owner uid ${ownerUid}, proxy uid ${currentUid}): ${(error as Error).message}. ${ownershipFix}`,
    );
  }
}

/** Creates the proxy server. The caller starts it with `httpServer.listen`. */
export function createClaudeProxyServer(options: ClaudeProxyServerOptions): ClaudeProxyServer {
  // `requests.sqlite` holds the refresh tokens of the subscription accounts, so only the user can read the directory.
  fs.mkdirSync(options.claudeProxyDirectory, { recursive: true, mode: 0o700 });
  makeClaudeProxyFilePrivate(options.claudeProxyDirectory, options.claudeProxyDirectory, 0o700);
  // SQLite creates the database, WAL and shared-memory files with the default mode. The proxy checks them before it opens
  // the database, so that it never opens a file of another user, and again after, so that the new files are private too.
  const makeRequestDatabaseFilesPrivate = () => {
    for (const fileName of fs.readdirSync(options.claudeProxyDirectory)) {
      if (fileName.startsWith('requests.sqlite')) {
        makeClaudeProxyFilePrivate(options.claudeProxyDirectory, path.join(options.claudeProxyDirectory, fileName), 0o600);
      }
    }
  };
  makeRequestDatabaseFilesPrivate();
  for (const configFileName of ['subscription_accounts.yml', 'pricing.yml']) {
    const configFilePath = path.join(options.claudeProxyDirectory, configFileName);
    if (!fs.existsSync(configFilePath)) fs.copyFileSync(path.join(defaultConfigDirectory, configFileName), configFilePath);
  }

  const subscriptionAccountsConfigFile = new YamlConfigFile<SubscriptionAccountsConfig>(
    path.join(options.claudeProxyDirectory, 'subscription_accounts.yml'),
    (yamlValue) => parseSubscriptionAccountsConfig(yamlValue, os.homedir()),
    emptySubscriptionAccountsConfig,
  );
  const modelPricingConfigFile = new YamlConfigFile<ModelPricingTable>(
    path.join(options.claudeProxyDirectory, 'pricing.yml'),
    parseModelPricingConfig,
    new Map(),
  );
  const readConfigErrors = () =>
    [subscriptionAccountsConfigFile.read().loadError, modelPricingConfigFile.read().loadError].filter(
      (loadError): loadError is string => loadError !== null,
    );

  const requestDatabase = new RequestDatabase(path.join(options.claudeProxyDirectory, 'requests.sqlite'));
  requestDatabase.markUnfinishedRequestsInterrupted();
  const expireOldRequestContents = () => {
    try {
      const expiredRequestCount = requestDatabase.expireRequestContentsStartedBefore(
        new Date(Date.now() - requestContentsRetentionDays * 24 * 60 * 60 * 1000).toISOString(),
      );
      if (expiredRequestCount > 0) console.log(`Deleted the contents of ${expiredRequestCount} requests older than ${requestContentsRetentionDays} days.`);
    } catch (error) {
      console.error(`claude-proxy could not delete the contents of old requests: ${(error as Error).message}`);
    }
  };
  expireOldRequestContents();
  const requestContentsExpiryTimer = setInterval(expireOldRequestContents, 24 * 60 * 60 * 1000);
  requestContentsExpiryTimer.unref();
  const subscriptionAccountStore = new SubscriptionAccountStore(path.join(options.claudeProxyDirectory, 'requests.sqlite'));
  makeRequestDatabaseFilesPrivate();
  const readSubscriptionAccountsConfig = () => subscriptionAccountsConfigFile.read().config;
  // The router and the usage monitor share one refresher, so that one refresh at a time runs for each grant.
  const subscriptionAccountGrantRefresher = new SubscriptionAccountGrantRefresher(subscriptionAccountStore, options.oauthEndpoints);
  const subscriptionAccountRouter = new SubscriptionAccountRouter(
    subscriptionAccountStore,
    subscriptionAccountGrantRefresher,
    readSubscriptionAccountsConfig,
  );
  const subscriptionAccountUsageMonitor = new SubscriptionAccountUsageMonitor(
    subscriptionAccountStore,
    subscriptionAccountGrantRefresher,
    readSubscriptionAccountsConfig,
    options.anthropicBaseUrl,
  );

  const subscriptionAccountLoginHandler = new SubscriptionAccountLoginHandler({
    subscriptionAccountStore,
    readSubscriptionAccountsConfig,
    oauthEndpoints: options.oauthEndpoints,
    checkSubscriptionAccountUsageAfterLogin: (subscriptionAccountName) => {
      subscriptionAccountUsageMonitor.checkSubscriptionAccountUsage(subscriptionAccountName).catch((error: Error) => {
        console.error(`claude-proxy could not poll the usage of subscription account ${subscriptionAccountName} after its login: ${error.message}`);
      });
    },
  });

  const proxyRequest = (clientRequest: IncomingMessage, clientResponse: ServerResponse) =>
    handleProxyRequest(clientRequest, clientResponse, {
      requestDatabase,
      subscriptionAccountRouter,
      readModelPricingTable: () => modelPricingConfigFile.read().config,
      anthropicBaseUrl: options.anthropicBaseUrl,
    });

  const dispatchRequest = async (clientRequest: IncomingMessage, clientResponse: ServerResponse): Promise<void> => {
    const requestPath = clientRequest.url ?? '/';
    if (!isAcceptedRequest(clientRequest, httpServer, options.publicHostname)) {
      const acceptedHostNames = options.publicHostname === null ? '127.0.0.1 or localhost' : `127.0.0.1, localhost or ${options.publicHostname}`;
      clientResponse.writeHead(403, { 'content-type': 'text/plain' });
      clientResponse.end(`claude-proxy accepts only requests addressed to ${acceptedHostNames}.`);
      return;
    }
    if (requestPath.startsWith(webApiPathPrefix)) {
      await handleWebApiRequest(clientRequest, clientResponse, {
        requestDatabase,
        readConfigErrors,
        subscriptionAccountStore,
        subscriptionAccountUsageMonitor,
        subscriptionAccountLoginHandler,
        readSubscriptionAccountsConfig,
        claudeCodeProjectsDirectory: options.claudeCodeProjectsDirectory,
      });
    } else if (requestPath.startsWith(webUiPathPrefix)) {
      handleWebUiStaticFileRequest(clientRequest, clientResponse, options.webUiDistDirectory);
    } else if (clientRequest.method === 'GET' && (requestPath === '/' || requestPath === '/_proxy')) {
      clientResponse.writeHead(302, { location: webUiPathPrefix });
      clientResponse.end();
    } else if (anthropicApiPathPrefixes.some((anthropicApiPathPrefix) => requestPath.startsWith(anthropicApiPathPrefix))) {
      await proxyRequest(clientRequest, clientResponse);
    } else {
      clientResponse.writeHead(404, { 'content-type': 'text/plain' });
      clientResponse.end('claude-proxy forwards only Anthropic API paths (/v1/ and /api/). The web UI is at /_proxy/.');
    }
  };

  const createRequestServer = (handleRequest: typeof dispatchRequest) => {
    const requestServer = http.createServer((clientRequest, clientResponse) => {
      handleRequest(clientRequest, clientResponse).catch((error: Error) => {
        console.error(`claude-proxy failed on ${clientRequest.method} ${clientRequest.url}: ${error.stack}`);
        if (!clientResponse.headersSent) clientResponse.writeHead(500, { 'content-type': 'text/plain' });
        clientResponse.end();
      });
    });
    // Requests with extended thinking can run for many minutes.
    requestServer.requestTimeout = 0;
    return requestServer;
  };

  const httpServer = createRequestServer(dispatchRequest);

  // The client reached api.anthropic.com through a CONNECT tunnel to the loopback listener, so every
  // decrypted request is local. It carries Host api.anthropic.com, and every path goes to Anthropic.
  const interceptedAnthropicApiServer = createRequestServer(proxyRequest);
  interceptedAnthropicApiServer.on('clientError', (error: Error, decryptedSocket: Duplex) => {
    console.error(`claude-proxy dropped an intercepted api.anthropic.com connection: ${error.message}`);
    decryptedSocket.destroy();
  });

  const connectClientSockets = new Set<Duplex>();
  const trackConnectClientSocket = (trackedSocket: Duplex) => {
    connectClientSockets.add(trackedSocket);
    trackedSocket.on('close', () => connectClientSockets.delete(trackedSocket));
  };
  httpServer.on('connect', (connectRequest: IncomingMessage, clientSocket: Duplex, connectRequestHead: Buffer) => {
    if (options.publicHostname !== null) {
      // Node removes its own error listener before it emits `connect`. Without this one, a reset crashes the proxy.
      clientSocket.on('error', () => clientSocket.destroy());
      clientSocket.end('HTTP/1.1 405 Method Not Allowed\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    handleHttpsProxyConnect(connectRequest, clientSocket, connectRequestHead, {
      anthropicApiCertificatePath: path.join(options.claudeProxyDirectory, 'api.anthropic.com.pem'),
      anthropicApiCertificateKeyPath: path.join(options.claudeProxyDirectory, 'api.anthropic.com-key.pem'),
      interceptedAnthropicApiServer,
      trackClientSocket: trackConnectClientSocket,
    });
  });

  httpServer.on('upgrade', (upgradeRequest: IncomingMessage, clientSocket: Duplex, upgradeRequestHead: Buffer) => {
    // Node removes its own error listener before it emits `upgrade`. Without this one, a reset crashes the proxy.
    clientSocket.on('error', () => clientSocket.destroy());
    const refuseUpgrade = (statusLine: string, message: string) =>
      clientSocket.end(`HTTP/1.1 ${statusLine}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${message}\n`);
    if (!isAcceptedRequest(upgradeRequest, httpServer, options.publicHostname)) {
      refuseUpgrade('403 Forbidden', 'claude-proxy does not accept requests addressed to this host name.');
    } else if ((upgradeRequest.url ?? '').split('?')[0] !== claudeProxyTunnelPath) {
      refuseUpgrade('404 Not Found', `claude-proxy upgrades only ${claudeProxyTunnelPath}.`);
    } else if (upgradeRequest.headers.upgrade?.toLowerCase() !== claudeProxyTunnelUpgradeToken) {
      refuseUpgrade('400 Bad Request', `claude-proxy upgrades only to ${claudeProxyTunnelUpgradeToken}.`);
    } else {
      handleClaudeProxyTunnelUpgrade(upgradeRequestHead, clientSocket, {
        anthropicApiCertificatePath: path.join(options.claudeProxyDirectory, 'api.anthropic.com.pem'),
        anthropicApiCertificateKeyPath: path.join(options.claudeProxyDirectory, 'api.anthropic.com-key.pem'),
        interceptedAnthropicApiServer,
        trackClientSocket: trackConnectClientSocket,
      });
    }
  });

  return {
    httpServer,
    requestDatabase,
    subscriptionAccountStore,
    subscriptionAccountRouter,
    subscriptionAccountUsageMonitor,
    async close() {
      clearInterval(requestContentsExpiryTimer);
      subscriptionAccountUsageMonitor.stop();
      httpServer.closeAllConnections();
      for (const connectClientSocket of connectClientSockets) connectClientSocket.destroy();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      requestDatabase.close();
      subscriptionAccountStore.close();
    },
  };
}
