import { DatabaseSync } from 'node:sqlite';

export interface SubscriptionAccountGrant {
  subscriptionAccountName: string;
  accountUuid: string;
  organizationUuid: string | null;
  emailAddress: string | null;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  accessTokenExpiresAt: number;
  isRefreshTokenRejected: boolean;
}

export interface SubscriptionAccountUsageWindow {
  /** `5h`, `7d`, or a model display name such as `Fable`. */
  usageWindowName: string;
  /** A fraction from 0 to 1. */
  utilization: number;
  /** ISO 8601. */
  resetsAt: string | null;
}

export interface SubscriptionAccountLimitBlock {
  subscriptionAccountName: string;
  /** An empty string blocks every model. */
  blockedModel: string;
  /** The representative claim, such as `five_hour`, `seven_day` or `seven_day_fable`. */
  rateLimitWindow: string;
  /** ISO 8601. */
  blockedUntil: string;
}

interface GrantRow {
  subscription_account_name: string;
  account_uuid: string;
  organization_uuid: string | null;
  email_address: string | null;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: number;
  is_refresh_token_rejected: number;
}

function grantFromRow(row: GrantRow | undefined): SubscriptionAccountGrant | null {
  if (!row) return null;
  return {
    subscriptionAccountName: row.subscription_account_name,
    accountUuid: row.account_uuid,
    organizationUuid: row.organization_uuid,
    emailAddress: row.email_address,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessTokenExpiresAt: row.access_token_expires_at,
    isRefreshTokenRejected: row.is_refresh_token_rejected === 1,
  };
}

/** Stores the OAuth grant, the usage windows and the limit blocks of each subscription account. */
export class SubscriptionAccountStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS subscription_account_grants (
        subscription_account_name TEXT PRIMARY KEY,
        account_uuid TEXT NOT NULL,
        organization_uuid TEXT,
        email_address TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        access_token_expires_at INTEGER NOT NULL,
        is_refresh_token_rejected INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS subscription_account_usage_windows (
        subscription_account_name TEXT NOT NULL,
        usage_window_name TEXT NOT NULL,
        utilization REAL NOT NULL,
        resets_at TEXT,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (subscription_account_name, usage_window_name)
      );

      CREATE TABLE IF NOT EXISTS subscription_account_limit_blocks (
        subscription_account_name TEXT NOT NULL,
        blocked_model TEXT NOT NULL,
        rate_limit_window TEXT NOT NULL,
        blocked_until TEXT NOT NULL,
        PRIMARY KEY (subscription_account_name, blocked_model)
      );
    `);
  }

  readGrant(subscriptionAccountName: string): SubscriptionAccountGrant | null {
    const row = this.database
      .prepare('SELECT * FROM subscription_account_grants WHERE subscription_account_name = ?')
      .get(subscriptionAccountName) as GrantRow | undefined;
    return grantFromRow(row);
  }

  findGrantByAccountIdentity(accountUuid: string, organizationUuid: string | null): SubscriptionAccountGrant | null {
    const row = this.database
      .prepare('SELECT * FROM subscription_account_grants WHERE account_uuid = ? AND organization_uuid IS ?')
      .get(accountUuid, organizationUuid) as GrantRow | undefined;
    return grantFromRow(row);
  }

  writeGrant(grant: SubscriptionAccountGrant): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO subscription_account_grants (
          subscription_account_name, account_uuid, organization_uuid, email_address, access_token, refresh_token,
          access_token_expires_at, is_refresh_token_rejected
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grant.subscriptionAccountName,
        grant.accountUuid,
        grant.organizationUuid,
        grant.emailAddress,
        grant.accessToken,
        grant.refreshToken,
        grant.accessTokenExpiresAt,
        grant.isRefreshTokenRejected ? 1 : 0,
      );
  }

  /** `checkedAt` is the latest check time over all usage windows of the subscription account. */
  readUsageWindows(subscriptionAccountName: string): { usageWindows: SubscriptionAccountUsageWindow[]; checkedAt: string | null } {
    const rows = this.database
      .prepare(
        `SELECT usage_window_name, utilization, resets_at, checked_at FROM subscription_account_usage_windows
         WHERE subscription_account_name = ? ORDER BY usage_window_name`,
      )
      .all(subscriptionAccountName) as {
      usage_window_name: string;
      utilization: number;
      resets_at: string | null;
      checked_at: string;
    }[];
    return {
      usageWindows: rows.map((row) => ({
        usageWindowName: row.usage_window_name,
        utilization: row.utilization,
        resetsAt: row.resets_at,
      })),
      checkedAt: rows.reduce<string | null>((latest, row) => (latest === null || row.checked_at > latest ? row.checked_at : latest), null),
    };
  }

  /** Replaces the usage windows with the same name and keeps the other usage windows. */
  mergeUsageWindows(subscriptionAccountName: string, usageWindows: SubscriptionAccountUsageWindow[], checkedAt: string): void {
    const writeUsageWindow = this.database.prepare(
      `INSERT OR REPLACE INTO subscription_account_usage_windows (
        subscription_account_name, usage_window_name, utilization, resets_at, checked_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    this.database.exec('BEGIN');
    try {
      for (const usageWindow of usageWindows) {
        writeUsageWindow.run(subscriptionAccountName, usageWindow.usageWindowName, usageWindow.utilization, usageWindow.resetsAt, checkedAt);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  writeLimitBlock(limitBlock: SubscriptionAccountLimitBlock): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO subscription_account_limit_blocks (
          subscription_account_name, blocked_model, rate_limit_window, blocked_until
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(limitBlock.subscriptionAccountName, limitBlock.blockedModel, limitBlock.rateLimitWindow, limitBlock.blockedUntil);
  }

  /** Deletes blocks whose blockedUntil has passed, then returns the rest. */
  readActiveLimitBlocks(now: Date): SubscriptionAccountLimitBlock[] {
    this.database.prepare('DELETE FROM subscription_account_limit_blocks WHERE blocked_until <= ?').run(now.toISOString());
    const rows = this.database
      .prepare(
        `SELECT subscription_account_name, blocked_model, rate_limit_window, blocked_until
         FROM subscription_account_limit_blocks ORDER BY subscription_account_name, blocked_model`,
      )
      .all() as {
      subscription_account_name: string;
      blocked_model: string;
      rate_limit_window: string;
      blocked_until: string;
    }[];
    return rows.map((row) => ({
      subscriptionAccountName: row.subscription_account_name,
      blockedModel: row.blocked_model,
      rateLimitWindow: row.rate_limit_window,
      blockedUntil: row.blocked_until,
    }));
  }

  deleteLimitBlocks(subscriptionAccountName: string, blockedModel: string): void {
    this.database
      .prepare('DELETE FROM subscription_account_limit_blocks WHERE subscription_account_name = ? AND blocked_model = ?')
      .run(subscriptionAccountName, blockedModel);
  }

  close(): void {
    this.database.close();
  }
}
