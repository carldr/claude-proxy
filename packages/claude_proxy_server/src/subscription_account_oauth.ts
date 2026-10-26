import { createHash, randomBytes } from 'node:crypto';
import type { SubscriptionAccountGrant, SubscriptionAccountStore } from './subscription_account_store.ts';

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
}

export const anthropicOAuthEndpoints: OAuthEndpoints = {
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
};

const claudeCodeOAuthClientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const claudeCodeOAuthScopes =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins';
const tokenEndpointTimeoutMilliseconds = 30_000;
const accessTokenRefreshMarginMilliseconds = 5 * 60_000;

export interface PendingSubscriptionAccountLogin {
  subscriptionAccountName: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  account?: { uuid?: string; email_address?: string };
  organization?: { uuid?: string };
}

/** Builds the authorize URL of the Claude Code OAuth client, with a PKCE challenge. */
export function startSubscriptionAccountLogin(
  subscriptionAccountName: string,
  redirectUri: string,
  endpoints: OAuthEndpoints,
): { pendingLogin: PendingSubscriptionAccountLogin; authorizeUrl: string } {
  const pendingLogin: PendingSubscriptionAccountLogin = {
    subscriptionAccountName,
    codeVerifier: randomBytes(32).toString('base64url'),
    state: randomBytes(32).toString('base64url'),
    redirectUri,
  };
  const authorizeUrl = new URL(endpoints.authorizeUrl);
  authorizeUrl.searchParams.set('code', 'true');
  authorizeUrl.searchParams.set('client_id', claudeCodeOAuthClientId);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', claudeCodeOAuthScopes);
  authorizeUrl.searchParams.set('code_challenge', createHash('sha256').update(pendingLogin.codeVerifier).digest('base64url'));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', pendingLogin.state);
  return { pendingLogin, authorizeUrl: authorizeUrl.toString() };
}

class TokenEndpointError extends Error {
  readonly isRefreshTokenPermanentlyRejected: boolean;

  constructor(message: string, isRefreshTokenPermanentlyRejected: boolean) {
    super(message);
    this.isRefreshTokenPermanentlyRejected = isRefreshTokenPermanentlyRejected;
  }
}

async function postToTokenEndpoint(endpoints: OAuthEndpoints, requestBody: Record<string, string>): Promise<TokenEndpointResponse> {
  const response = await fetch(endpoints.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(tokenEndpointTimeoutMilliseconds),
  });
  const responseText = await response.text();
  if (!response.ok) {
    let errorCode: unknown;
    try {
      errorCode = (JSON.parse(responseText) as { error?: unknown }).error;
    } catch {
      errorCode = undefined;
    }
    const isInvalidGrant = [400, 401, 403].includes(response.status) && errorCode === 'invalid_grant';
    throw new TokenEndpointError(`Token endpoint answered ${response.status}: ${responseText}`, isInvalidGrant);
  }
  try {
    return JSON.parse(responseText) as TokenEndpointResponse;
  } catch {
    throw new TokenEndpointError(`Token endpoint answered invalid JSON: ${responseText}`, false);
  }
}

/** Exchanges the code, and returns the grant without storing it. Throws with the token endpoint's error text. */
export async function exchangeSubscriptionAccountLoginCode(
  pendingLogin: PendingSubscriptionAccountLogin,
  code: string,
  endpoints: OAuthEndpoints,
): Promise<SubscriptionAccountGrant> {
  const tokenResponse = await postToTokenEndpoint(endpoints, {
    grant_type: 'authorization_code',
    code,
    code_verifier: pendingLogin.codeVerifier,
    state: pendingLogin.state,
    redirect_uri: pendingLogin.redirectUri,
    client_id: claudeCodeOAuthClientId,
  });
  if (!tokenResponse.access_token || !tokenResponse.refresh_token || typeof tokenResponse.expires_in !== 'number') {
    throw new Error('Token endpoint answered without an access token, a refresh token or an expiry.');
  }
  if (!tokenResponse.account?.uuid) throw new Error('Token endpoint answered without the account identity.');
  return {
    subscriptionAccountName: pendingLogin.subscriptionAccountName,
    accountUuid: tokenResponse.account.uuid,
    organizationUuid: tokenResponse.organization?.uuid ?? null,
    emailAddress: tokenResponse.account.email_address ?? null,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    accessTokenExpiresAt: Date.now() + tokenResponse.expires_in * 1000,
    isRefreshTokenRejected: false,
  };
}

/**
 * Keeps the access token of each proxy-owned grant live.
 * A refresh rotates the refresh token, so two parallel refreshes of one grant would kill it.
 * The refresher therefore runs one refresh at a time for each subscription account.
 */
export class SubscriptionAccountGrantRefresher {
  private readonly subscriptionAccountStore: SubscriptionAccountStore;
  private readonly endpoints: OAuthEndpoints;
  private readonly refreshesInFlight = new Map<string, Promise<string | null>>();

  constructor(subscriptionAccountStore: SubscriptionAccountStore, endpoints: OAuthEndpoints) {
    this.subscriptionAccountStore = subscriptionAccountStore;
    this.endpoints = endpoints;
  }

  /** Returns a live access token, refreshing first when it expires within 5 minutes. Null when there is no live grant. */
  async readAccessToken(subscriptionAccountName: string): Promise<string | null> {
    const refreshInFlight = this.refreshesInFlight.get(subscriptionAccountName);
    if (refreshInFlight) return refreshInFlight;
    const grant = this.subscriptionAccountStore.readGrant(subscriptionAccountName);
    if (!grant || grant.isRefreshTokenRejected) return null;
    if (grant.accessTokenExpiresAt - Date.now() > accessTokenRefreshMarginMilliseconds) return grant.accessToken;
    const refresh = this.refreshGrant(grant).finally(() => this.refreshesInFlight.delete(subscriptionAccountName));
    this.refreshesInFlight.set(subscriptionAccountName, refresh);
    return refresh;
  }

  private async refreshGrant(grant: SubscriptionAccountGrant): Promise<string | null> {
    let tokenResponse: TokenEndpointResponse;
    try {
      tokenResponse = await postToTokenEndpoint(this.endpoints, {
        grant_type: 'refresh_token',
        refresh_token: grant.refreshToken,
        client_id: claudeCodeOAuthClientId,
      });
    } catch (error) {
      if (error instanceof TokenEndpointError && error.isRefreshTokenPermanentlyRejected) {
        if (this.isGrantStillRefreshed(grant)) this.subscriptionAccountStore.writeGrant({ ...grant, isRefreshTokenRejected: true });
        return this.readLiveAccessTokenOfReplacedGrant(grant);
      }
      throw error;
    }
    if (!tokenResponse.access_token || typeof tokenResponse.expires_in !== 'number') {
      throw new Error('Token endpoint answered a refresh without an access token or an expiry.');
    }
    if (!this.isGrantStillRefreshed(grant)) return this.readLiveAccessTokenOfReplacedGrant(grant);
    this.subscriptionAccountStore.writeGrant({
      ...grant,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? grant.refreshToken,
      accessTokenExpiresAt: Date.now() + tokenResponse.expires_in * 1000,
      accountUuid: tokenResponse.account?.uuid ?? grant.accountUuid,
      organizationUuid: tokenResponse.organization?.uuid ?? grant.organizationUuid,
      emailAddress: tokenResponse.account?.email_address ?? grant.emailAddress,
    });
    return tokenResponse.access_token;
  }

  /** A login can store a new grant while a refresh is in flight. The refresh result then belongs to the replaced grant. */
  private isGrantStillRefreshed(refreshedGrant: SubscriptionAccountGrant): boolean {
    const storedGrant = this.subscriptionAccountStore.readGrant(refreshedGrant.subscriptionAccountName);
    return storedGrant?.refreshToken === refreshedGrant.refreshToken;
  }

  private readLiveAccessTokenOfReplacedGrant(refreshedGrant: SubscriptionAccountGrant): string | null {
    const storedGrant = this.subscriptionAccountStore.readGrant(refreshedGrant.subscriptionAccountName);
    if (!storedGrant || storedGrant.isRefreshTokenRejected) return null;
    return storedGrant.accessTokenExpiresAt > Date.now() ? storedGrant.accessToken : null;
  }
}
