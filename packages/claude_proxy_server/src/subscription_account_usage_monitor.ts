import type { SubscriptionAccountGrantRefresher } from './subscription_account_oauth.ts';
import type { SubscriptionAccountStore, SubscriptionAccountUsageWindow } from './subscription_account_store.ts';
import type { SubscriptionAccountsConfig } from './subscription_accounts_config.ts';

const usageCheckIntervalMilliseconds = 5 * 60 * 1000;
const usageCheckTimeoutMilliseconds = 30_000;

interface UsageReportWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

function parseUsageReportWindow(usageWindowName: string, reportWindow: UsageReportWindow | null | undefined, percent: unknown = reportWindow?.utilization) {
  if (typeof percent !== 'number') return null;
  const resetsAt = reportWindow?.resets_at;
  // The stored reset time must be in `toISOString` form, because the failover rule compares reset times as strings.
  const resetsAtDate = typeof resetsAt === 'string' ? new Date(resetsAt) : null;
  return {
    usageWindowName,
    utilization: percent / 100,
    resetsAt: resetsAtDate !== null && !Number.isNaN(resetsAtDate.getTime()) ? resetsAtDate.toISOString() : null,
  };
}

/**
 * Reads the usage windows from the answer of `/api/oauth/usage`.
 * The report gives percentages from 0 to 100. This function returns fractions from 0 to 1.
 * It skips every window that the report omits.
 */
export function parseSubscriptionAccountUsageReport(usageReport: unknown): SubscriptionAccountUsageWindow[] {
  if (typeof usageReport !== 'object' || usageReport === null) return [];
  const report = usageReport as { five_hour?: UsageReportWindow | null; seven_day?: UsageReportWindow | null; limits?: unknown };
  const usageWindows = [parseUsageReportWindow('5h', report.five_hour), parseUsageReportWindow('7d', report.seven_day)];
  if (Array.isArray(report.limits)) {
    for (const limit of report.limits as { scope?: { model?: { display_name?: unknown } }; percent?: unknown; resets_at?: unknown }[]) {
      const modelName = limit?.scope?.model?.display_name;
      if (typeof modelName === 'string') usageWindows.push(parseUsageReportWindow(modelName, limit, limit.percent));
    }
  }
  return usageWindows.filter((usageWindow): usageWindow is SubscriptionAccountUsageWindow => usageWindow !== null);
}

/** The usage window that a whole-account block names, by the claim of its rate limit window. */
const usageWindowNameByRateLimitWindow: Record<string, string> = { five_hour: '5h', seven_day: '7d' };

/** Polls the usage of each subscription account with its own grant, every 5 minutes. */
export class SubscriptionAccountUsageMonitor {
  private readonly subscriptionAccountStore: SubscriptionAccountStore;
  private readonly grantRefresher: SubscriptionAccountGrantRefresher;
  private readonly readSubscriptionAccountsConfig: () => SubscriptionAccountsConfig;
  private readonly anthropicBaseUrl: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    subscriptionAccountStore: SubscriptionAccountStore,
    grantRefresher: SubscriptionAccountGrantRefresher,
    readSubscriptionAccountsConfig: () => SubscriptionAccountsConfig,
    anthropicBaseUrl: string,
  ) {
    this.subscriptionAccountStore = subscriptionAccountStore;
    this.grantRefresher = grantRefresher;
    this.readSubscriptionAccountsConfig = readSubscriptionAccountsConfig;
    this.anthropicBaseUrl = anthropicBaseUrl;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkAllSubscriptionAccountUsage().then((usageCheckErrors) => {
        for (const usageCheckError of usageCheckErrors) console.error(`claude-proxy usage check failed for ${usageCheckError}`);
      });
    }, usageCheckIntervalMilliseconds);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Polls every subscription account with a live grant. Returns one error message per failed account. */
  async checkAllSubscriptionAccountUsage(): Promise<string[]> {
    const usageCheckErrors: string[] = [];
    for (const { name: subscriptionAccountName } of this.readSubscriptionAccountsConfig().subscriptionAccounts) {
      try {
        await this.checkSubscriptionAccountUsage(subscriptionAccountName);
      } catch (error) {
        usageCheckErrors.push(`${subscriptionAccountName}: ${(error as Error).message}`);
      }
    }
    return usageCheckErrors;
  }

  async checkSubscriptionAccountUsage(subscriptionAccountName: string): Promise<void> {
    const accessToken = await this.grantRefresher.readAccessToken(subscriptionAccountName);
    if (accessToken === null) return;
    const usageResponse = await fetch(`${this.anthropicBaseUrl}/api/oauth/usage`, {
      headers: { authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(usageCheckTimeoutMilliseconds),
    });
    if (!usageResponse.ok) throw new Error(`/api/oauth/usage answered ${usageResponse.status}`);
    const usageWindows = parseSubscriptionAccountUsageReport(await usageResponse.json());
    this.subscriptionAccountStore.mergeUsageWindows(subscriptionAccountName, usageWindows, new Date().toISOString());
    this.clearWholeAccountBlockWithRoom(subscriptionAccountName, usageWindows);
  }

  /** The usage poll is the only way to learn that a block ended before its reset time. */
  private clearWholeAccountBlockWithRoom(subscriptionAccountName: string, usageWindows: SubscriptionAccountUsageWindow[]): void {
    const wholeAccountBlock = this.subscriptionAccountStore
      .readActiveLimitBlocks(new Date())
      .find((limitBlock) => limitBlock.subscriptionAccountName === subscriptionAccountName && limitBlock.blockedModel === '');
    if (!wholeAccountBlock) return;
    const blockedUsageWindow = usageWindows.find(
      (usageWindow) => usageWindow.usageWindowName === usageWindowNameByRateLimitWindow[wholeAccountBlock.rateLimitWindow],
    );
    if (blockedUsageWindow && blockedUsageWindow.utilization < 1) this.subscriptionAccountStore.deleteLimitBlocks(subscriptionAccountName, '');
  }
}
