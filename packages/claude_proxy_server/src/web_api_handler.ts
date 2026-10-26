import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProxiedRequestFilters, RequestDatabase } from './request_database.ts';
import type { SubscriptionAccountLoginHandler } from './subscription_account_login_handler.ts';
import type { SubscriptionAccountStore, SubscriptionAccountUsageWindow } from './subscription_account_store.ts';
import type { SubscriptionAccountUsageMonitor } from './subscription_account_usage_monitor.ts';
import { isSubscriptionAccountAboveFailoverUtilization } from './subscription_account_router.ts';
import type { SubscriptionAccountsConfig } from './subscription_accounts_config.ts';

export const webApiPathPrefix = '/_proxy/api/';

export interface WebApiHandlerDependencies {
  requestDatabase: RequestDatabase;
  readConfigErrors: () => string[];
  subscriptionAccountStore: SubscriptionAccountStore;
  subscriptionAccountUsageMonitor: SubscriptionAccountUsageMonitor;
  subscriptionAccountLoginHandler: SubscriptionAccountLoginHandler;
  readSubscriptionAccountsConfig: () => SubscriptionAccountsConfig;
  claudeCodeProjectsDirectory: string;
}

export interface SubscriptionAccountStatus {
  subscriptionAccounts: {
    subscriptionAccountName: string;
    colour: string;
    emailAddress: string | null;
    loginState: 'logged_in' | 'login_required';
    /** The `7d` usage window, as a fraction from 0 to 1. */
    weeklyUtilization: number | null;
    /** True for a block on the whole account, not on one model, and for an account at the failover utilization. */
    isBlocked: boolean;
    blockedUntil: string | null;
    /** The window of the whole-account block, such as `five_hour` or `seven_day`. Null when no such block is active. */
    blockedRateLimitWindow: string | null;
    usageWindows: SubscriptionAccountUsageWindow[];
    usageCheckedAt: string | null;
    /** The fraction of a 5-hour or weekly window at which the proxy avoids this account. 1 means no threshold. */
    failoverUtilization: number;
  }[];
  configErrors: string[];
}

function buildSubscriptionAccountStatus(dependencies: WebApiHandlerDependencies): SubscriptionAccountStatus {
  const { subscriptionAccountStore } = dependencies;
  const activeLimitBlocks = subscriptionAccountStore.readActiveLimitBlocks(new Date());
  const subscriptionAccountsConfig = dependencies.readSubscriptionAccountsConfig();
  return {
    subscriptionAccounts: subscriptionAccountsConfig.subscriptionAccounts.map((subscriptionAccount) => {
      const grant = subscriptionAccountStore.readGrant(subscriptionAccount.name);
      const { usageWindows, checkedAt } = subscriptionAccountStore.readUsageWindows(subscriptionAccount.name);
      const wholeAccountBlock = activeLimitBlocks.find(
        (limitBlock) => limitBlock.subscriptionAccountName === subscriptionAccount.name && limitBlock.blockedModel === '',
      );
      return {
        subscriptionAccountName: subscriptionAccount.name,
        colour: subscriptionAccount.colour,
        emailAddress: grant?.emailAddress ?? null,
        loginState: grant && !grant.isRefreshTokenRejected ? 'logged_in' : 'login_required',
        weeklyUtilization: usageWindows.find((usageWindow) => usageWindow.usageWindowName === '7d')?.utilization ?? null,
        isBlocked:
          wholeAccountBlock !== undefined ||
          isSubscriptionAccountAboveFailoverUtilization(usageWindows, subscriptionAccount.failoverUtilization, new Date()),
        blockedUntil: wholeAccountBlock?.blockedUntil ?? null,
        blockedRateLimitWindow: wholeAccountBlock?.rateLimitWindow ?? null,
        usageWindows,
        usageCheckedAt: checkedAt,
        failoverUtilization: subscriptionAccount.failoverUtilization,
      };
    }),
    configErrors: dependencies.readConfigErrors(),
  };
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
  const { requestDatabase } = dependencies;
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

    if (clientRequest.method === 'GET' && apiPath === 'subscription-account-status') {
      return sendJson(clientResponse, 200, buildSubscriptionAccountStatus(dependencies));
    }

    if (clientRequest.method === 'POST' && apiPath === 'subscription-account-usage-check') {
      const usageCheckErrors = await dependencies.subscriptionAccountUsageMonitor.checkAllSubscriptionAccountUsage();
      return sendJson(clientResponse, 200, { ...buildSubscriptionAccountStatus(dependencies), usageCheckErrors });
    }

    const loginSubscriptionAccountNameMatch = /^subscription-accounts\/([^/]+)\/login$/.exec(apiPath);
    if (clientRequest.method === 'POST' && loginSubscriptionAccountNameMatch) {
      return sendJson(
        clientResponse,
        200,
        dependencies.subscriptionAccountLoginHandler.startLogin(decodeURIComponent(loginSubscriptionAccountNameMatch[1])),
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
