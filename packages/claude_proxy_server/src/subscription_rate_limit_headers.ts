import type { IncomingHttpHeaders } from 'node:http';

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
