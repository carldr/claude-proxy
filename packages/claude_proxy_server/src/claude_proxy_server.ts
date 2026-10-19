import fs from 'node:fs';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { parseApiKeyRoutesConfig, type ApiKeyRoute } from './api_key_routes_config.ts';
import { parseModelPricingConfig, type ModelPricingTable } from './model_pricing_config.ts';
import { handleProxyRequest } from './proxy_request_handler.ts';
import { RequestDatabase } from './request_database.ts';
import { RoutingState } from './routing_state.ts';
import { SubscriptionUsageMonitor } from './subscription_usage_monitor.ts';
import { handleWebApiRequest, webApiPathPrefix } from './web_api_handler.ts';
import { handleWebUiStaticFileRequest, webUiPathPrefix } from './web_ui_static_file_handler.ts';
import { YamlConfigFile } from './yaml_config_file.ts';

export interface ClaudeProxyServerOptions {
  /** Holds `routes.yml`, `pricing.yml` and `requests.sqlite`. Normally `~/.claude-proxy`. */
  claudeProxyDirectory: string;
  anthropicBaseUrl: string;
  webUiDistDirectory: string;
  claudeCodeProjectsDirectory: string;
}

export interface ClaudeProxyServer {
  httpServer: Server;
  requestDatabase: RequestDatabase;
  routingState: RoutingState;
  subscriptionUsageMonitor: SubscriptionUsageMonitor;
  close(): Promise<void>;
}

const defaultConfigDirectory = path.join(import.meta.dirname, '..', 'default_config');

/**
 * The proxy forwards and records only these paths. Claude Code uses no others. Other paths, such as a browser
 * tab left on port 4100, get a local 404 and are not recorded.
 */
const anthropicApiPathPrefixes = ['/v1/', '/api/'];

/**
 * Accepts a request only when its Host is 127.0.0.1 or localhost on the proxy's port, and when it has no Origin
 * or the proxy's own Origin. This stops web pages, including pages that use DNS rebinding, from reading recorded
 * requests or from sending requests that the proxy would send with an API key. Claude Code sends no Origin header.
 */
function isLocalRequest(clientRequest: IncomingMessage, httpServer: Server): boolean {
  const proxyPort = (httpServer.address() as AddressInfo).port;
  const localHosts = [`127.0.0.1:${proxyPort}`, `localhost:${proxyPort}`];
  if (!localHosts.includes(clientRequest.headers.host ?? '')) return false;
  const origin = clientRequest.headers.origin;
  return origin === undefined || localHosts.some((localHost) => origin === `http://${localHost}`);
}

/** Creates the proxy server. The caller starts it with `httpServer.listen`. */
export function createClaudeProxyServer(options: ClaudeProxyServerOptions): ClaudeProxyServer {
  fs.mkdirSync(options.claudeProxyDirectory, { recursive: true });
  for (const configFileName of ['routes.yml', 'pricing.yml']) {
    const configFilePath = path.join(options.claudeProxyDirectory, configFileName);
    if (!fs.existsSync(configFilePath)) fs.copyFileSync(path.join(defaultConfigDirectory, configFileName), configFilePath);
  }

  const apiKeyRoutesConfigFile = new YamlConfigFile<ApiKeyRoute[]>(
    path.join(options.claudeProxyDirectory, 'routes.yml'),
    parseApiKeyRoutesConfig,
    [],
  );
  const modelPricingConfigFile = new YamlConfigFile<ModelPricingTable>(
    path.join(options.claudeProxyDirectory, 'pricing.yml'),
    parseModelPricingConfig,
    new Map(),
  );
  const readConfigErrors = () =>
    [apiKeyRoutesConfigFile.read().loadError, modelPricingConfigFile.read().loadError].filter(
      (loadError): loadError is string => loadError !== null,
    );

  const requestDatabase = new RequestDatabase(path.join(options.claudeProxyDirectory, 'requests.sqlite'));
  requestDatabase.markUnfinishedRequestsInterrupted();
  const routingState = new RoutingState(requestDatabase, () => apiKeyRoutesConfigFile.read().config);
  const subscriptionUsageMonitor = new SubscriptionUsageMonitor(routingState, options.anthropicBaseUrl);

  const dispatchRequest = async (clientRequest: IncomingMessage, clientResponse: ServerResponse): Promise<void> => {
    const requestPath = clientRequest.url ?? '/';
    if (!isLocalRequest(clientRequest, httpServer)) {
      clientResponse.writeHead(403, { 'content-type': 'text/plain' });
      clientResponse.end('claude-proxy accepts requests only from this computer, addressed to 127.0.0.1 or localhost.');
      return;
    }
    if (requestPath.startsWith(webApiPathPrefix)) {
      await handleWebApiRequest(clientRequest, clientResponse, {
        requestDatabase,
        routingState,
        readConfigErrors,
        checkSubscriptionUsage: () => subscriptionUsageMonitor.checkSubscriptionUsage(),
        claudeCodeProjectsDirectory: options.claudeCodeProjectsDirectory,
      });
    } else if (requestPath.startsWith(webUiPathPrefix)) {
      handleWebUiStaticFileRequest(clientRequest, clientResponse, options.webUiDistDirectory);
    } else if (clientRequest.method === 'GET' && (requestPath === '/' || requestPath === '/_proxy')) {
      clientResponse.writeHead(302, { location: webUiPathPrefix });
      clientResponse.end();
    } else if (anthropicApiPathPrefixes.some((anthropicApiPathPrefix) => requestPath.startsWith(anthropicApiPathPrefix))) {
      await handleProxyRequest(clientRequest, clientResponse, {
        requestDatabase,
        routingState,
        readModelPricingTable: () => modelPricingConfigFile.read().config,
        anthropicBaseUrl: options.anthropicBaseUrl,
        rememberSubscriptionAccessToken: (accessToken) => subscriptionUsageMonitor.rememberAccessToken(accessToken),
      });
    } else {
      clientResponse.writeHead(404, { 'content-type': 'text/plain' });
      clientResponse.end('claude-proxy forwards only Anthropic API paths (/v1/ and /api/). The web UI is at /_proxy/.');
    }
  };

  const httpServer = http.createServer((clientRequest, clientResponse) => {
    dispatchRequest(clientRequest, clientResponse).catch((error: Error) => {
      console.error(`claude-proxy failed on ${clientRequest.method} ${clientRequest.url}: ${error.stack}`);
      if (!clientResponse.headersSent) clientResponse.writeHead(500, { 'content-type': 'text/plain' });
      clientResponse.end();
    });
  });
  // Requests with extended thinking can run for many minutes.
  httpServer.requestTimeout = 0;

  return {
    httpServer,
    requestDatabase,
    routingState,
    subscriptionUsageMonitor,
    async close() {
      subscriptionUsageMonitor.stop();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      requestDatabase.close();
    },
  };
}
