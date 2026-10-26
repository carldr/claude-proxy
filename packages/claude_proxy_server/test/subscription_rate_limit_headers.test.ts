import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingHttpHeaders } from 'node:http';
import { readSubscriptionRateLimit } from '../src/subscription_rate_limit_headers.ts';

const now = new Date('2026-10-26T12:00:00.000Z');

function unifiedHeaders(headers: Record<string, string>): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [`anthropic-ratelimit-unified-${name}`, value]));
}

test('reads 5h and 7d usage from an allowed response', () => {
  const rateLimit = readSubscriptionRateLimit(
    200,
    unifiedHeaders({
      '5h-utilization': '0.09',
      '5h-reset': '1793035800',
      '5h-status': 'allowed',
      '7d-utilization': '0.93',
      '7d-reset': '1793185200',
      '7d-status': 'allowed_warning',
      'representative-claim': 'seven_day',
      reset: '1793185200',
      status: 'allowed_warning',
    }),
    now,
  );
  assert.deepEqual(rateLimit.usageWindows, [
    { usageWindowName: '5h', utilization: 0.09, resetsAt: new Date(1793035800 * 1000).toISOString() },
    { usageWindowName: '7d', utilization: 0.93, resetsAt: new Date(1793185200 * 1000).toISOString() },
  ]);
  assert.equal(rateLimit.rejection, null);
});

test('reads a five-hour rejection', () => {
  const rateLimit = readSubscriptionRateLimit(
    429,
    unifiedHeaders({ status: 'rejected', 'representative-claim': 'five_hour', '5h-reset': '1793035800', reset: '1793035800' }),
    now,
  );
  assert.deepEqual(rateLimit.rejection, {
    rateLimitWindow: 'five_hour',
    isModelWindow: false,
    blockedUntil: new Date(1793035800 * 1000),
  });
});

test('reads a weekly rejection', () => {
  const rateLimit = readSubscriptionRateLimit(
    429,
    unifiedHeaders({ '7d-status': 'rejected', 'representative-claim': 'seven_day', '7d-reset': '1793185200', '5h-reset': '1793035800' }),
    now,
  );
  assert.deepEqual(rateLimit.rejection, {
    rateLimitWindow: 'seven_day',
    isModelWindow: false,
    blockedUntil: new Date(1793185200 * 1000),
  });
});

test('reads a per-model weekly rejection', () => {
  const rateLimit = readSubscriptionRateLimit(
    429,
    unifiedHeaders({ status: 'rejected', 'representative-claim': 'seven_day_fable', '7d-reset': '1793185200', reset: '1793300000' }),
    now,
  );
  assert.deepEqual(rateLimit.rejection, {
    rateLimitWindow: 'seven_day_fable',
    isModelWindow: true,
    blockedUntil: new Date(1793300000 * 1000),
  });
});

test('treats a 429 without a rejected status, and a 529, as no rejection', () => {
  const headers = unifiedHeaders({ status: 'allowed', 'representative-claim': 'five_hour', '5h-reset': '1793035800' });
  assert.equal(readSubscriptionRateLimit(429, headers, now).rejection, null);
  const rejectedHeaders = unifiedHeaders({ status: 'rejected', 'representative-claim': 'five_hour', '5h-reset': '1793035800' });
  assert.equal(readSubscriptionRateLimit(529, rejectedHeaders, now).rejection, null);
});

test('blocks for one hour when the rejection names no reset time', () => {
  const rateLimit = readSubscriptionRateLimit(429, unifiedHeaders({ status: 'rejected', 'representative-claim': 'seven_day' }), now);
  assert.deepEqual(rateLimit.rejection?.blockedUntil, new Date('2026-10-26T13:00:00.000Z'));
});
