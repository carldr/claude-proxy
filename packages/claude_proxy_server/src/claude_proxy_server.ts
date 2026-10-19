import fs from 'node:fs';
import http, { type Server } from 'node:http';
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

  const httpServer = http.createServer((clientRequest, clientResponse) => {
    const requestPath = clientRequest.url ?? '/';
    let handling: Promise<void> | void = undefined;
    if (requestPath.startsWith(webApiPathPrefix)) {
      handling = handleWebApiRequest(clientRequest, clientResponse, {
        requestDatabase,
        routingState,
        readConfigErrors,
        claudeCodeProjectsDirectory: options.claudeCodeProjectsDirectory,
      });
    } else if (requestPath.startsWith(webUiPathPrefix)) {
      handling = handleWebUiStaticFileRequest(clientRequest, clientResponse, options.webUiDistDirectory);
    } else if (clientRequest.method === 'GET' && (requestPath === '/' || requestPath === '/_proxy')) {
      clientResponse.writeHead(302, { location: webUiPathPrefix });
      clientResponse.end();
    } else {
      handling = handleProxyRequest(clientRequest, clientResponse, {
        requestDatabase,
        routingState,
        readModelPricingTable: () => modelPricingConfigFile.read().config,
        anthropicBaseUrl: options.anthropicBaseUrl,
        rememberSubscriptionAccessToken: (accessToken) => subscriptionUsageMonitor.rememberAccessToken(accessToken),
      });
    }
    Promise.resolve(handling).catch((error: Error) => {
      console.error(`claude-proxy failed on ${clientRequest.method} ${requestPath}: ${error.stack}`);
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
