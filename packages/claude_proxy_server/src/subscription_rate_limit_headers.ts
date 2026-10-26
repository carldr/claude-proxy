import type { IncomingHttpHeaders } from 'node:http';
import type { SubscriptionAccountUsageWindow } from './subscription_account_store.ts';

export interface SubscriptionWeeklyRateLimit {
  /** Fraction of the weekly limit used, from 0 to 1. */
  weeklyUtilization: number | null;
  weeklyResetsAt: Date | null;
  /** True when the subscription rejected the request because of a weekly window. */
  isWeeklyLimitRejection: boolean;
}

/**
 * Reads the `anthropic-ratelimit-unified-*` headers that Anthropic returns on subscription (OAuth) responses.
 * `representative-claim` names the window that limits the request, for example `five_hour` or `seven_day`.
 */
export function readSubscriptionWeeklyRateLimit(statusCode: number, responseHeaders: IncomingHttpHeaders): SubscriptionWeeklyRateLimit {
  const readHeader = (headerName: string): string | undefined => {
    const headerValue = responseHeaders[`anthropic-ratelimit-unified-${headerName}`];
    return Array.isArray(headerValue) ? headerValue[0] : headerValue;
  };

  const weeklyUtilizationText = readHeader('7d-utilization');
  const weeklyUtilization = weeklyUtilizationText === undefined ? NaN : Number(weeklyUtilizationText);
  const weeklyResetText = readHeader('7d-reset');
  const weeklyResetEpochSeconds = weeklyResetText === undefined ? NaN : Number(weeklyResetText);

  const isWeeklyWindowRejected =
    readHeader('7d-status') === 'rejected' ||
    (readHeader('status') === 'rejected' && (readHeader('representative-claim') ?? '').startsWith('seven_day'));

  return {
    weeklyUtilization: Number.isFinite(weeklyUtilization) ? weeklyUtilization : null,
    weeklyResetsAt: Number.isFinite(weeklyResetEpochSeconds) ? new Date(weeklyResetEpochSeconds * 1000) : null,
    isWeeklyLimitRejection: statusCode === 429 && isWeeklyWindowRejected,
  };
}

export interface SubscriptionRateLimitRejection {
  /** The representative claim of the response, for example `five_hour`, `seven_day` or `seven_day_fable`. */
  rateLimitWindow: string;
  /** True when the claim is a weekly window of one model. */
  isModelWindow: boolean;
  blockedUntil: Date;
}

export interface SubscriptionRateLimit {
  /** The `5h` and `7d` windows whose utilization header is present. */
  usageWindows: SubscriptionAccountUsageWindow[];
  rejection: SubscriptionRateLimitRejection | null;
}

const BLOCK_DURATION_WITHOUT_RESET_MILLISECONDS = 60 * 60 * 1000;

/**
 * Reads the `anthropic-ratelimit-unified-*` headers of one subscription response.
 * A rejection needs status 429 and a rejected status in the response.
 * The blocked time ends at the reset of the window, else at the general reset, else one hour after `now`.
 */
export function readSubscriptionRateLimit(statusCode: number, responseHeaders: IncomingHttpHeaders, now: Date): SubscriptionRateLimit {
  const readHeader = (headerName: string): string | undefined => {
    const headerValue = responseHeaders[`anthropic-ratelimit-unified-${headerName}`];
    return Array.isArray(headerValue) ? headerValue[0] : headerValue;
  };
  const readResetDate = (headerName: string): Date | null => {
    const resetText = readHeader(headerName);
    const resetEpochSeconds = resetText === undefined ? NaN : Number(resetText);
    return Number.isFinite(resetEpochSeconds) ? new Date(resetEpochSeconds * 1000) : null;
  };

  const usageWindows: SubscriptionAccountUsageWindow[] = [];
  for (const usageWindowName of ['5h', '7d']) {
    const utilizationText = readHeader(`${usageWindowName}-utilization`);
    const utilization = utilizationText === undefined ? NaN : Number(utilizationText);
    if (Number.isFinite(utilization)) {
      usageWindows.push({ usageWindowName, utilization, resetsAt: readResetDate(`${usageWindowName}-reset`)?.toISOString() ?? null });
    }
  }

  const rateLimitWindow = readHeader('representative-claim') ?? '';
  const ownWindowName = rateLimitWindow === 'five_hour' ? '5h' : rateLimitWindow === 'seven_day' ? '7d' : null;
  const isModelWindow = rateLimitWindow.startsWith('seven_day_');
  if (statusCode !== 429 || (ownWindowName === null && !isModelWindow)) {
    return { usageWindows, rejection: null };
  }
  const isRejected = readHeader('status') === 'rejected' || (ownWindowName !== null && readHeader(`${ownWindowName}-status`) === 'rejected');
  if (!isRejected) {
    return { usageWindows, rejection: null };
  }
  const blockedUntil =
    (ownWindowName === null ? null : readResetDate(`${ownWindowName}-reset`)) ??
    readResetDate('reset') ??
    new Date(now.getTime() + BLOCK_DURATION_WITHOUT_RESET_MILLISECONDS);
  return { usageWindows, rejection: { rateLimitWindow, isModelWindow, blockedUntil } };
}
