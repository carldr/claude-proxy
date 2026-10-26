import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SubscriptionAccountStore, type SubscriptionAccountGrant } from '../src/subscription_account_store.ts';

function withStore(run: (store: SubscriptionAccountStore) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'subscription_account_store_'));
  const store = new SubscriptionAccountStore(path.join(directory, 'requests.sqlite'));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const personalGrant: SubscriptionAccountGrant = {
  subscriptionAccountName: 'Personal',
  accountUuid: 'account-uuid-1',
  organizationUuid: 'organization-uuid-1',
  emailAddress: 'person@example.com',
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  accessTokenExpiresAt: 1_800_000_000_000,
  isRefreshTokenRejected: false,
};

test('stores a grant and finds it by account identity', () => {
  withStore((store) => {
    assert.equal(store.readGrant('Personal'), null);
    store.writeGrant(personalGrant);
    assert.deepEqual(store.readGrant('Personal'), personalGrant);
    assert.deepEqual(store.findGrantByAccountIdentity('account-uuid-1', 'organization-uuid-1'), personalGrant);
    assert.equal(store.findGrantByAccountIdentity('other-account-uuid', 'organization-uuid-1'), null);
  });
});

test('replaces a grant on a second write', () => {
  withStore((store) => {
    store.writeGrant(personalGrant);
    store.writeGrant({ ...personalGrant, refreshToken: 'refresh-token-2', isRefreshTokenRejected: true });
    const grant = store.readGrant('Personal');
    assert.equal(grant?.refreshToken, 'refresh-token-2');
    assert.equal(grant?.isRefreshTokenRejected, true);
  });
});

test('merges usage windows by name', () => {
  withStore((store) => {
    assert.deepEqual(store.readUsageWindows('Personal'), { usageWindows: [], checkedAt: null });
    store.mergeUsageWindows(
      'Personal',
      [
        { usageWindowName: '5h', utilization: 0.2, resetsAt: '2026-10-26T15:00:00Z' },
        { usageWindowName: '7d', utilization: 0.5, resetsAt: null },
      ],
      '2026-10-26T10:00:00Z',
    );
    store.mergeUsageWindows('Personal', [{ usageWindowName: '7d', utilization: 0.7, resetsAt: '2026-10-30T00:00:00Z' }], '2026-10-26T11:00:00Z');
    const { usageWindows, checkedAt } = store.readUsageWindows('Personal');
    assert.equal(checkedAt, '2026-10-26T11:00:00Z');
    assert.deepEqual(
      [...usageWindows].sort((a, b) => a.usageWindowName.localeCompare(b.usageWindowName)),
      [
        { usageWindowName: '5h', utilization: 0.2, resetsAt: '2026-10-26T15:00:00Z' },
        { usageWindowName: '7d', utilization: 0.7, resetsAt: '2026-10-30T00:00:00Z' },
      ],
    );
  });
});

test('expires limit blocks at blockedUntil', () => {
  withStore((store) => {
    const now = new Date('2026-10-26T10:00:00Z');
    const limitBlock = {
      subscriptionAccountName: 'Personal',
      blockedModel: '',
      rateLimitWindow: 'five_hour',
      blockedUntil: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    store.writeLimitBlock(limitBlock);
    assert.deepEqual(store.readActiveLimitBlocks(now), [limitBlock]);
    assert.deepEqual(store.readActiveLimitBlocks(new Date(now.getTime() + 7_200_000)), []);
    assert.deepEqual(store.readActiveLimitBlocks(now), []);
  });
});

test('keeps a whole-account block and a model block apart', () => {
  withStore((store) => {
    const blockedUntil = '2099-01-01T00:00:00.000Z';
    const wholeAccountBlock = { subscriptionAccountName: 'Personal', blockedModel: '', rateLimitWindow: 'seven_day', blockedUntil };
    const modelBlock = { subscriptionAccountName: 'Personal', blockedModel: 'claude-fable-5-1', rateLimitWindow: 'seven_day_fable', blockedUntil };
    store.writeLimitBlock(wholeAccountBlock);
    store.writeLimitBlock(modelBlock);
    assert.equal(store.readActiveLimitBlocks(new Date()).length, 2);
    store.deleteLimitBlocks('Personal', '');
    assert.deepEqual(store.readActiveLimitBlocks(new Date()), [modelBlock]);
  });
});

test('keeps an active block that ends later when a shorter block of the same scope arrives', () => {
  withStore((store) => {
    const now = Date.now();
    const weeklyBlock = { subscriptionAccountName: 'Personal', blockedModel: '', rateLimitWindow: 'seven_day', blockedUntil: new Date(now + 3 * 86_400_000).toISOString() };
    const fiveHourBlock = { subscriptionAccountName: 'Personal', blockedModel: '', rateLimitWindow: 'five_hour', blockedUntil: new Date(now + 2 * 3_600_000).toISOString() };
    store.writeLimitBlock(weeklyBlock);
    store.writeLimitBlock(fiveHourBlock);
    assert.deepEqual(store.readActiveLimitBlocks(new Date(now)), [weeklyBlock]);
  });
});
