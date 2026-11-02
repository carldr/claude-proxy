import {
  exchangeSubscriptionAccountLoginCode,
  startSubscriptionAccountLogin,
  type OAuthEndpoints,
  type PendingSubscriptionAccountLogin,
} from './subscription_account_oauth.ts';
import type { SubscriptionAccountStore } from './subscription_account_store.ts';
import type { SubscriptionAccountsConfig } from './subscription_accounts_config.ts';

/**
 * The OAuth client of Claude Code registers this redirect URI. The page there shows the
 * authorization code and the state as `<code>#<state>`, for the user to paste into the web UI.
 */
export const subscriptionAccountManualRedirectUri = 'https://platform.claude.com/oauth/code/callback';

const pendingLoginLifetimeMilliseconds = 10 * 60_000;

export interface SubscriptionAccountLoginHandlerDependencies {
  subscriptionAccountStore: SubscriptionAccountStore;
  readSubscriptionAccountsConfig: () => SubscriptionAccountsConfig;
  oauthEndpoints: OAuthEndpoints;
  /** Starts a usage poll of the account that logged in, so its usage shows before the next 5-minute poll. */
  checkSubscriptionAccountUsageAfterLogin: (subscriptionAccountName: string) => void;
}

/** Starts logins of subscription accounts, and finishes them with the code that the user pastes into the web UI. */
export class SubscriptionAccountLoginHandler {
  private readonly dependencies: SubscriptionAccountLoginHandlerDependencies;
  private readonly pendingLoginsByState = new Map<string, { pendingLogin: PendingSubscriptionAccountLogin; expiresAt: number }>();

  constructor(dependencies: SubscriptionAccountLoginHandlerDependencies) {
    this.dependencies = dependencies;
  }

  /** Keeps a pending login for 10 minutes and returns the URL that the browser opens. Throws for an unknown subscription account. */
  startLogin(subscriptionAccountName: string): { authorizeUrl: string } {
    const isConfigured = this.dependencies.readSubscriptionAccountsConfig().subscriptionAccounts.some(
      (subscriptionAccount) => subscriptionAccount.name === subscriptionAccountName,
    );
    if (!isConfigured) throw new Error(`Subscription account "${subscriptionAccountName}" is not in subscription_accounts.yml.`);
    const now = Date.now();
    for (const [state, { expiresAt }] of this.pendingLoginsByState) {
      if (expiresAt <= now) this.pendingLoginsByState.delete(state);
    }
    const { pendingLogin, authorizeUrl } = startSubscriptionAccountLogin(
      subscriptionAccountName,
      subscriptionAccountManualRedirectUri,
      this.dependencies.oauthEndpoints,
    );
    this.pendingLoginsByState.set(pendingLogin.state, { pendingLogin, expiresAt: now + pendingLoginLifetimeMilliseconds });
    return { authorizeUrl };
  }

  /** Takes the text that the manual code page shows, `<code>#<state>`. Throws an error that names the cause when the login cannot finish. */
  async finishLogin(pastedAuthorizationCode: string): Promise<void> {
    const trimmedText = pastedAuthorizationCode.trim();
    const separatorIndex = trimmedText.lastIndexOf('#');
    if (separatorIndex === -1) {
      throw new Error('The pasted text has no #. Paste the whole code that the page shows, in the form <code>#<state>.');
    }
    const code = trimmedText.slice(0, separatorIndex);
    const state = trimmedText.slice(separatorIndex + 1);
    const pending = this.pendingLoginsByState.get(state);
    this.pendingLoginsByState.delete(state);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new Error('The state is unknown or expired. Start the login again from the web UI.');
    }
    const isStillConfigured = this.dependencies.readSubscriptionAccountsConfig().subscriptionAccounts.some(
      (subscriptionAccount) => subscriptionAccount.name === pending.pendingLogin.subscriptionAccountName,
    );
    if (!isStillConfigured) {
      throw new Error(`Subscription account "${pending.pendingLogin.subscriptionAccountName}" is no longer in subscription_accounts.yml.`);
    }
    if (!code) throw new Error('The pasted text has no code before the #.');

    const grant = await exchangeSubscriptionAccountLoginCode(pending.pendingLogin, code, this.dependencies.oauthEndpoints);
    const { subscriptionAccountStore } = this.dependencies;
    const grantOfSameIdentity = subscriptionAccountStore.findGrantByAccountIdentity(grant.accountUuid, grant.organizationUuid);
    if (grantOfSameIdentity && grantOfSameIdentity.subscriptionAccountName !== grant.subscriptionAccountName) {
      const isOtherNameConfigured = this.dependencies.readSubscriptionAccountsConfig().subscriptionAccounts.some(
        (subscriptionAccount) => subscriptionAccount.name === grantOfSameIdentity.subscriptionAccountName,
      );
      if (isOtherNameConfigured) {
        throw new Error(
          `This Claude account is already logged in as ${grantOfSameIdentity.subscriptionAccountName}. ` +
            `Log in to ${grant.subscriptionAccountName} with a different Claude account.`,
        );
      }
      // A name that is no longer configured is the old name of a renamed account. The login deletes its rows.
      subscriptionAccountStore.deleteSubscriptionAccount(grantOfSameIdentity.subscriptionAccountName);
    }
    const replacedGrant = subscriptionAccountStore.readGrant(grant.subscriptionAccountName);
    const isReplacedGrantOfOtherIdentity =
      replacedGrant !== null &&
      (replacedGrant.accountUuid !== grant.accountUuid || replacedGrant.organizationUuid !== grant.organizationUuid);
    // The usage windows and the limit blocks describe the Claude account of the replaced grant.
    if (isReplacedGrantOfOtherIdentity) subscriptionAccountStore.deleteUsageWindowsAndLimitBlocks(grant.subscriptionAccountName);
    subscriptionAccountStore.writeGrant(grant);
    this.dependencies.checkSubscriptionAccountUsageAfterLogin(grant.subscriptionAccountName);
  }
}
