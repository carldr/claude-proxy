import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  exchangeSubscriptionAccountLoginCode,
  startSubscriptionAccountLogin,
  type OAuthEndpoints,
  type PendingSubscriptionAccountLogin,
} from './subscription_account_oauth.ts';
import type { SubscriptionAccountStore } from './subscription_account_store.ts';
import type { SubscriptionAccountsConfig } from './subscription_accounts_config.ts';
import { webUiPathPrefix } from './web_ui_static_file_handler.ts';

/**
 * The path must be `/callback`, because the OAuth client of Claude Code registers that path
 * for a redirect URI on localhost.
 */
export const subscriptionAccountLoginCallbackPath = '/callback';

const pendingLoginLifetimeMilliseconds = 10 * 60_000;

export interface SubscriptionAccountLoginHandlerDependencies {
  subscriptionAccountStore: SubscriptionAccountStore;
  readSubscriptionAccountsConfig: () => SubscriptionAccountsConfig;
  oauthEndpoints: OAuthEndpoints;
  readListeningPort: () => number;
  /** Starts a usage poll of the account that logged in, so its usage shows before the next 5-minute poll. */
  checkSubscriptionAccountUsageAfterLogin: (subscriptionAccountName: string) => void;
}

/** Starts logins of subscription accounts, and finishes them when the browser returns to the loopback callback. */
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
    const redirectUri = `http://localhost:${this.dependencies.readListeningPort()}${subscriptionAccountLoginCallbackPath}`;
    const { pendingLogin, authorizeUrl } = startSubscriptionAccountLogin(subscriptionAccountName, redirectUri, this.dependencies.oauthEndpoints);
    this.pendingLoginsByState.set(pendingLogin.state, { pendingLogin, expiresAt: now + pendingLoginLifetimeMilliseconds });
    return { authorizeUrl };
  }

  /** Answers `302` to the web UI after a stored grant, and `400` with plain text that names the cause otherwise. */
  async handleCallbackRequest(clientRequest: IncomingMessage, clientResponse: ServerResponse): Promise<void> {
    try {
      await this.finishLogin(new URL(clientRequest.url ?? '/', 'http://claude-proxy').searchParams);
    } catch (error) {
      clientResponse.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      clientResponse.end(`Login failed: ${(error as Error).message}`);
      return;
    }
    clientResponse.writeHead(302, { location: webUiPathPrefix });
    clientResponse.end();
  }

  private async finishLogin(callbackParameters: URLSearchParams): Promise<void> {
    const state = callbackParameters.get('state') ?? '';
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
    const authorizationError = callbackParameters.get('error');
    if (authorizationError) throw new Error(`The authorization server answered ${authorizationError}.`);
    const code = callbackParameters.get('code');
    if (!code) throw new Error('The callback has no code.');

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
