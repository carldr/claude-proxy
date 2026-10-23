import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProxiedRequestFilters, RequestDatabase } from './request_database.ts';
import type { RoutingMode, RoutingState } from './routing_state.ts';
import { readIncomingBody } from './upstream_http_request.ts';

export const webApiPathPrefix = '/_proxy/api/';

export interface WebApiHandlerDependencies {
  requestDatabase: RequestDatabase;
  routingState: RoutingState;
  readConfigErrors: () => string[];
  /** Returns an error message, or null on success. */
  checkSubscriptionUsage: () => Promise<string | null>;
  claudeCodeProjectsDirectory: string;
}

/** Serves the JSON API that the web UI and the menu bar app read. */
export async function handleWebApiRequest(
  clientRequest: IncomingMessage,
  clientResponse: ServerResponse,
  dependencies: WebApiHandlerDependencies,
): Promise<void> {
  const requestUrl = new URL(clientRequest.url ?? '/', 'http://claude-proxy');
  const apiPath = requestUrl.pathname.slice(webApiPathPrefix.length);
  const queryParameters = requestUrl.searchParams;
  const readQueryParameter = (parameterName: string) => queryParameters.get(parameterName) || undefined;
  const { requestDatabase, routingState } = dependencies;
  const readProxiedRequestFilters = (): ProxiedRequestFilters => ({
    startedFrom: readQueryParameter('startedFrom'),
    startedTo: readQueryParameter('startedTo'),
    model: readQueryParameter('model'),
    routeName: readQueryParameter('routeName'),
    status: readQueryParameter('status'),
    projectPath: readQueryParameter('projectPath'),
    sessionId: readQueryParameter('sessionId'),
    searchText: readQueryParameter('searchText'),
  });

  try {
    if (clientRequest.method === 'GET' && apiPath === 'routing-status') {
      return sendJson(clientResponse, 200, { ...routingState.readRoutingStatus(), configErrors: dependencies.readConfigErrors() });
    }

    if (clientRequest.method === 'PUT' && apiPath === 'routing-settings') {
      const routingSettings = JSON.parse((await readIncomingBody(clientRequest)).toString('utf8')) as {
        routingMode?: RoutingMode;
        selectedApiKeyRouteName?: string;
      };
      if (routingSettings.routingMode !== undefined) routingState.setRoutingMode(routingSettings.routingMode);
      if (routingSettings.selectedApiKeyRouteName !== undefined) {
        routingState.setSelectedApiKeyRouteName(routingSettings.selectedApiKeyRouteName);
      }
      return sendJson(clientResponse, 200, { ...routingState.readRoutingStatus(), configErrors: dependencies.readConfigErrors() });
    }

    if (clientRequest.method === 'POST' && apiPath === 'subscription-usage-check') {
      const checkError = await dependencies.checkSubscriptionUsage();
      return sendJson(clientResponse, checkError === null ? 200 : 502, {
        ...routingState.readRoutingStatus(),
        configErrors: dependencies.readConfigErrors(),
        subscriptionUsageCheckError: checkError,
      });
    }

    if (clientRequest.method === 'GET' && apiPath === 'proxied-requests') {
      return sendJson(
        clientResponse,
        200,
        requestDatabase.listProxiedRequests(readProxiedRequestFilters(), {
          beforeId: readQueryParameter('beforeId') ? Number(readQueryParameter('beforeId')) : undefined,
          limit: Math.min(Number(readQueryParameter('limit') ?? 100), 500),
        }),
      );
    }

    if (clientRequest.method === 'GET' && apiPath === 'proxied-request-cost-totals') {
      const dayMs = 24 * 60 * 60 * 1000;
      return sendJson(
        clientResponse,
        200,
        requestDatabase.summariseProxiedRequestCosts(
          readProxiedRequestFilters(),
          new Date(Date.now() - 30 * dayMs).toISOString(),
          new Date(Date.now() - dayMs).toISOString(),
        ),
      );
    }

    const proxiedRequestIdMatch = /^proxied-requests\/(\d+)$/.exec(apiPath);
    if (clientRequest.method === 'GET' && proxiedRequestIdMatch) {
      const proxiedRequest = requestDatabase.readProxiedRequest(Number(proxiedRequestIdMatch[1]));
      return proxiedRequest ? sendJson(clientResponse, 200, proxiedRequest) : sendJson(clientResponse, 404, { error: 'Not found' });
    }

    if (clientRequest.method === 'GET' && apiPath === 'request-filter-options') {
      return sendJson(clientResponse, 200, requestDatabase.listRequestFilterOptions(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()));
    }

    if (clientRequest.method === 'GET' && apiPath === 'cost-summary') {
      const dayCount = Number(readQueryParameter('days') ?? 30);
      const startedFrom = new Date(Date.now() - dayCount * 24 * 60 * 60 * 1000).toISOString();
      return sendJson(clientResponse, 200, requestDatabase.summariseCostsByDayAndRoute(startedFrom));
    }

    if (clientRequest.method === 'GET' && apiPath === 'sessions') {
      const sessions = requestDatabase.listSessions(readQueryParameter('projectPath'), Math.min(Number(readQueryParameter('limit') ?? 200), 1000));
      const sessionLogFilePaths = findClaudeCodeSessionLogFiles(dependencies.claudeCodeProjectsDirectory);
      return sendJson(
        clientResponse,
        200,
        sessions.map((session) => ({ ...session, session_log_file_path: sessionLogFilePaths.get(String(session.session_id)) ?? null })),
      );
    }

    return sendJson(clientResponse, 404, { error: `No API endpoint ${clientRequest.method} ${requestUrl.pathname}` });
  } catch (error) {
    return sendJson(clientResponse, 400, { error: (error as Error).message });
  }
}

/** Maps each session ID to its log file, `~/.claude/projects/<encoded project path>/<session ID>.jsonl`. */
function findClaudeCodeSessionLogFiles(claudeCodeProjectsDirectory: string): Map<string, string> {
  const sessionLogFilePaths = new Map<string, string>();
  let projectDirectoryNames: string[];
  try {
    projectDirectoryNames = fs.readdirSync(claudeCodeProjectsDirectory);
  } catch {
    return sessionLogFilePaths;
  }
  for (const projectDirectoryName of projectDirectoryNames) {
    const projectDirectory = path.join(claudeCodeProjectsDirectory, projectDirectoryName);
    let fileNames: string[];
    try {
      fileNames = fs.readdirSync(projectDirectory);
    } catch {
      continue;
    }
    for (const fileName of fileNames) {
      if (fileName.endsWith('.jsonl')) sessionLogFilePaths.set(fileName.slice(0, -'.jsonl'.length), path.join(projectDirectory, fileName));
    }
  }
  return sessionLogFilePaths;
}

export const defaultClaudeCodeProjectsDirectory = path.join(os.homedir(), '.claude', 'projects');

function sendJson(clientResponse: ServerResponse, statusCode: number, responseValue: unknown): void {
  clientResponse.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  clientResponse.end(JSON.stringify(responseValue));
}
