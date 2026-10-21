import type { RoutingState } from './routing_state.ts';

export const subscriptionUsageCheckIntervalMs = 5 * 60 * 1000;

/**
 * While the weekly subscription limit is reached, asks Anthropic for the subscription usage every five minutes.
 * When usage is below 100% again, auto mode sends subscription traffic back to the subscription.
 * The usage endpoint is the one that Claude Code's `/usage` command reads. It needs a Claude Code OAuth access token,
 * so the monitor uses the most recent token that passed through the proxy.
 */
export class SubscriptionUsageMonitor {
  private latestAccessToken: string | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private readonly routingState: RoutingState;
  private readonly anthropicBaseUrl: string;

  constructor(routingState: RoutingState, anthropicBaseUrl: string) {
    this.routingState = routingState;
    this.anthropicBaseUrl = anthropicBaseUrl;
  }

  rememberAccessToken(accessToken: string): void {
    this.latestAccessToken = accessToken;
  }

  start(): void {
    this.checkTimer = setInterval(() => void this.checkUsageWhileLimitReached(), subscriptionUsageCheckIntervalMs);
    this.checkTimer.unref();
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
  }

  async checkUsageWhileLimitReached(): Promise<void> {
    if (!this.routingState.isSubscriptionWeeklyLimitReached()) return;
    const checkError = await this.checkSubscriptionUsage();
    if (checkError !== null) console.error(checkError);
  }

  /** Reads the weekly subscription usage from Anthropic and records it. Returns an error message, or null on success. */
  async checkSubscriptionUsage(): Promise<string | null> {
    if (this.latestAccessToken === null) return 'No Claude Code request has passed through the proxy since it started, so it has no OAuth token';
    try {
      const usageResponse = await fetch(`${this.anthropicBaseUrl}/api/oauth/usage`, {
        headers: {
          authorization: `Bearer ${this.latestAccessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!usageResponse.ok) return `Subscription usage check returned HTTP ${usageResponse.status}`;
      const usageReport = (await usageResponse.json()) as { seven_day?: { utilization?: number; resets_at?: string | null } };
      const weeklyUtilizationPercent = usageReport.seven_day?.utilization;
      if (typeof weeklyUtilizationPercent !== 'number') return 'Subscription usage check returned no seven_day.utilization';
      const weeklyResetsAt = usageReport.seven_day?.resets_at ? new Date(usageReport.seven_day.resets_at) : null;
      this.routingState.recordSubscriptionUsageCheck(weeklyUtilizationPercent / 100, weeklyResetsAt);
      return null;
    } catch (error) {
      return `Subscription usage check failed: ${(error as Error).message}`;
    }
  }
}
