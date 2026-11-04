import type { SubscriptionAccountGrantRefresher } from './subscription_account_oauth.ts';
import type { SubscriptionAccountStore, SubscriptionAccountUsageWindow } from './subscription_account_store.ts';
import { findSubscriptionAccountNameForProject, type SubscriptionAccountsConfig } from './subscription_accounts_config.ts';
import type { SubscriptionRateLimit } from './subscription_rate_limit_headers.ts';

export interface PlannedSubscriptionAccountRoute {
  subscriptionAccountName: string;
  /** Null when the subscription account has no live grant. The request then goes upstream with Claude Code's own token. */
  accessToken: string | null;
  /** True for the subscription account of the request's project. Its rejection goes to Claude Code when every route rejects. */
  isProjectSubscriptionAccount: boolean;
}

/**
 * Returns true when a model window, such as `Fable`, counts the requests of the model, such as `claude-fable-5-1`.
 * The window name is the model's display name, so it matches one hyphen-separated part of the model ID.
 */
export function isUsageWindowOfModel(usageWindowName: string, model: string): boolean {
  return model.toLowerCase().split('-').includes(usageWindowName.toLowerCase());
}

/**
 * Returns true when the usage window is at or above the failover utilization.
 * A failover utilization of 1 turns the check off, because a window at 1.00 can still take requests.
 * A window whose reset time has passed does not count, because its stored utilization is out of date.
 */
export function isUsageWindowAboveFailoverUtilization(usageWindow: SubscriptionAccountUsageWindow, failoverUtilization: number, now: Date): boolean {
  return (
    failoverUtilization < 1 &&
    usageWindow.utilization >= failoverUtilization &&
    (usageWindow.resetsAt === null || usageWindow.resetsAt > now.toISOString())
  );
}

/**
 * Returns true when a usage window that counts the request is at or above the failover utilization.
 * The 5-hour and the weekly windows count every request. A model window counts only the requests of its model,
 * so an account at its Fable threshold still takes Opus requests. A null model counts only the 5-hour and weekly windows.
 * The router and the subscription account status both use this rule.
 */
export function isSubscriptionAccountAboveFailoverUtilization(
  usageWindows: SubscriptionAccountUsageWindow[],
  failoverUtilization: number,
  model: string | null,
  now: Date,
): boolean {
  return usageWindows.some(
    (usageWindow) =>
      (usageWindow.usageWindowName === '5h' ||
        usageWindow.usageWindowName === '7d' ||
        (model !== null && isUsageWindowOfModel(usageWindow.usageWindowName, model))) &&
      isUsageWindowAboveFailoverUtilization(usageWindow, failoverUtilization, now),
  );
}

/**
 * Chooses the subscription accounts for a Claude Code message request, and records the limits that each response reports.
 * A project's own subscription account comes first. The other accounts follow in file order, as failover routes.
 */
export class SubscriptionAccountRouter {
  private readonly subscriptionAccountStore: SubscriptionAccountStore;
  private readonly grantRefresher: SubscriptionAccountGrantRefresher;
  private readonly readSubscriptionAccountsConfig: () => SubscriptionAccountsConfig;

  constructor(
    subscriptionAccountStore: SubscriptionAccountStore,
    grantRefresher: SubscriptionAccountGrantRefresher,
    readSubscriptionAccountsConfig: () => SubscriptionAccountsConfig,
  ) {
    this.subscriptionAccountStore = subscriptionAccountStore;
    this.grantRefresher = grantRefresher;
    this.readSubscriptionAccountsConfig = readSubscriptionAccountsConfig;
  }

  /**
   * Returns the routes to try in order. An empty plan means that the request goes upstream unchanged.
   * In each group, the project's own account comes first, and the other accounts follow in file order:
   * 1. the accounts that are not blocked;
   * 2. the accounts that a rejection blocks, because a block can end before its reset time;
   * 3. the project's own account at its failover utilization, as the last resort.
   * The plan omits any other account at its failover utilization, and any other account without a live grant.
   * The failover utilization applies to the 5-hour window, the weekly window and the weekly window of the request's model.
   */
  async planRoutes(projectPath: string | null, model: string | null, now: Date): Promise<PlannedSubscriptionAccountRoute[]> {
    const config = this.readSubscriptionAccountsConfig();
    if (config.subscriptionAccounts.length === 0) return [];

    const projectSubscriptionAccountName = findSubscriptionAccountNameForProject(config, projectPath);
    const activeLimitBlocks = this.subscriptionAccountStore.readActiveLimitBlocks(now);
    const isBlockedByRejection = (subscriptionAccountName: string) =>
      activeLimitBlocks.some(
        (limitBlock) =>
          limitBlock.subscriptionAccountName === subscriptionAccountName &&
          (limitBlock.blockedModel === '' || limitBlock.blockedModel === model),
      );
    const projectSubscriptionAccountFirst = [
      ...config.subscriptionAccounts.filter((subscriptionAccount) => subscriptionAccount.name === projectSubscriptionAccountName),
      ...config.subscriptionAccounts.filter((subscriptionAccount) => subscriptionAccount.name !== projectSubscriptionAccountName),
    ];

    const unblockedRoutes: PlannedSubscriptionAccountRoute[] = [];
    const rejectionBlockedRoutes: PlannedSubscriptionAccountRoute[] = [];
    let projectRouteAtFailoverUtilization: PlannedSubscriptionAccountRoute | null = null;
    for (const subscriptionAccount of projectSubscriptionAccountFirst) {
      const isProjectSubscriptionAccount = subscriptionAccount.name === projectSubscriptionAccountName;
      const isAtFailoverUtilization = isSubscriptionAccountAboveFailoverUtilization(
        this.subscriptionAccountStore.readUsageWindows(subscriptionAccount.name).usageWindows,
        subscriptionAccount.failoverUtilization,
        model,
        now,
      );
      if (isAtFailoverUtilization && !isProjectSubscriptionAccount) continue;
      const accessToken = await this.readLiveAccessToken(subscriptionAccount.name);
      if (accessToken === null && !isProjectSubscriptionAccount) continue;

      const plannedRoute = { subscriptionAccountName: subscriptionAccount.name, accessToken, isProjectSubscriptionAccount };
      if (isAtFailoverUtilization) projectRouteAtFailoverUtilization = plannedRoute;
      else if (isBlockedByRejection(subscriptionAccount.name)) rejectionBlockedRoutes.push(plannedRoute);
      else unblockedRoutes.push(plannedRoute);
    }
    const projectRoutesAtFailoverUtilization = projectRouteAtFailoverUtilization !== null ? [projectRouteAtFailoverUtilization] : [];
    return [...unblockedRoutes, ...rejectionBlockedRoutes, ...projectRoutesAtFailoverUtilization];
  }

  /** Stores the usage windows of a response. A rejection blocks the account, or only the model for a model window. */
  recordResponse(subscriptionAccountName: string, model: string | null, rateLimit: SubscriptionRateLimit): void {
    if (rateLimit.usageWindows.length > 0) {
      this.subscriptionAccountStore.mergeUsageWindows(subscriptionAccountName, rateLimit.usageWindows, new Date().toISOString());
    }
    if (rateLimit.rejection !== null) {
      this.subscriptionAccountStore.writeLimitBlock({
        subscriptionAccountName,
        blockedModel: rateLimit.rejection.isModelWindow ? (model ?? '') : '',
        rateLimitWindow: rateLimit.rejection.rateLimitWindow,
        blockedUntil: rateLimit.rejection.blockedUntil.toISOString(),
      });
    }
  }

  /** Returns null when the account has no live grant, or when the grant refresh fails. */
  private async readLiveAccessToken(subscriptionAccountName: string): Promise<string | null> {
    try {
      return await this.grantRefresher.readAccessToken(subscriptionAccountName);
    } catch (error) {
      console.error(`claude-proxy could not refresh the grant of subscription account ${subscriptionAccountName}: ${(error as Error).message}`);
      return null;
    }
  }
}
