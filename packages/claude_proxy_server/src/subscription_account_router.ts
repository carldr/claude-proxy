import type { SubscriptionAccountGrantRefresher } from './subscription_account_oauth.ts';
import type { SubscriptionAccountStore, SubscriptionAccountUsageWindow } from './subscription_account_store.ts';
import { findSubscriptionAccountNameForProject, type SubscriptionAccountsConfig } from './subscription_accounts_config.ts';
import type { SubscriptionRateLimit } from './subscription_rate_limit_headers.ts';

export interface PlannedSubscriptionAccountRoute {
  subscriptionAccountName: string;
  /** Null when the subscription account has no live grant. The request then goes upstream with Claude Code's own token. */
  accessToken: string | null;
}

/**
 * Returns true when the 5-hour or the weekly usage window is at or above the failover utilization.
 * The router and the subscription account status both use this rule.
 */
export function isSubscriptionAccountAboveFailoverUtilization(
  usageWindows: SubscriptionAccountUsageWindow[],
  failoverUtilization: number,
): boolean {
  return usageWindows.some(
    (usageWindow) =>
      (usageWindow.usageWindowName === '5h' || usageWindow.usageWindowName === '7d') && usageWindow.utilization >= failoverUtilization,
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
   * The plan holds the project's own account, then each other account that is not blocked and has a live grant.
   * A blocked own account goes last, so that every account blocked gives the project's own rejection.
   * Failover never goes to another account without a live grant.
   */
  async planRoutes(projectPath: string | null, model: string | null, now: Date): Promise<PlannedSubscriptionAccountRoute[]> {
    const config = this.readSubscriptionAccountsConfig();
    if (config.subscriptionAccounts.length === 0) return [];

    const ownSubscriptionAccountName = findSubscriptionAccountNameForProject(config, projectPath);
    const activeLimitBlocks = this.subscriptionAccountStore.readActiveLimitBlocks(now);
    const isBlocked = (subscriptionAccountName: string) =>
      activeLimitBlocks.some(
        (limitBlock) =>
          limitBlock.subscriptionAccountName === subscriptionAccountName &&
          (limitBlock.blockedModel === '' || limitBlock.blockedModel === model),
      ) ||
      isSubscriptionAccountAboveFailoverUtilization(
        this.subscriptionAccountStore.readUsageWindows(subscriptionAccountName).usageWindows,
        config.failoverUtilization,
      );

    const plannedRoutes: PlannedSubscriptionAccountRoute[] = [];
    for (const subscriptionAccount of config.subscriptionAccounts) {
      if (subscriptionAccount.name === ownSubscriptionAccountName || isBlocked(subscriptionAccount.name)) continue;
      const accessToken = await this.readLiveAccessToken(subscriptionAccount.name);
      if (accessToken !== null) plannedRoutes.push({ subscriptionAccountName: subscriptionAccount.name, accessToken });
    }
    if (ownSubscriptionAccountName === null) return plannedRoutes;

    const ownRoute = {
      subscriptionAccountName: ownSubscriptionAccountName,
      accessToken: await this.readLiveAccessToken(ownSubscriptionAccountName),
    };
    return isBlocked(ownSubscriptionAccountName) ? [...plannedRoutes, ownRoute] : [ownRoute, ...plannedRoutes];
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
