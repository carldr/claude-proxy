import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SubscriptionAccountGrantRefresher,
  anthropicOAuthEndpoints,
  exchangeSubscriptionAccountLoginCode,
  startSubscriptionAccountLogin,
  type OAuthEndpoints,
} from '../src/subscription_account_oauth.ts';
import { SubscriptionAccountStore, type SubscriptionAccountGrant } from '../src/subscription_account_store.ts';

interface ReceivedTokenRequest {
  path: string;
  body: Record<string, unknown>;
}

type TokenResponder = (response: http.ServerResponse) => void;

async function withFakeTokenServer(
  respond: TokenResponder,
  run: (context: { endpoints: OAuthEndpoints; receivedRequests: ReceivedTokenRequest[] }) => Promise<void>,
): Promise<void> {
  const receivedRequests: ReceivedTokenRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const bodyChunks: Buffer[] = [];
    for await (const bodyChunk of request) bodyChunks.push(bodyChunk as Buffer);
    receivedRequests.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) });
    respond(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ endpoints: { authorizeUrl: `${baseUrl}/authorize`, tokenUrl: `${baseUrl}/token` }, receivedRequests });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function answerJson(statusCode: number, body: unknown): TokenResponder {
  return (response) => {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

async function withStore(run: (store: SubscriptionAccountStore) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'subscription_account_oauth_'));
  const store = new SubscriptionAccountStore(path.join(directory, 'requests.sqlite'));
  try {
    await run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function personalGrant(accessTokenExpiresAt: number): SubscriptionAccountGrant {
  return {
    subscriptionAccountName: 'Personal',
    accountUuid: 'account-uuid-1',
    organizationUuid: 'organization-uuid-1',
    emailAddress: 'person@example.com',
    accessToken: 'old-access-token',
    refreshToken: 'old-refresh-token',
    accessTokenExpiresAt,
    isRefreshTokenRejected: false,
  };
}

const refreshedTokenResponse = { access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 28800 };

test('builds the authorize URL with PKCE and the Claude Code client', () => {
  const { pendingLogin, authorizeUrl } = startSubscriptionAccountLogin('Personal', 'http://localhost:4100/callback', anthropicOAuthEndpoints);
  const url = new URL(authorizeUrl);
  assert.equal(`${url.origin}${url.pathname}`, 'https://claude.com/cai/oauth/authorize');
  assert.equal(url.searchParams.get('code'), 'true');
  assert.equal(url.searchParams.get('client_id'), '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4100/callback');
  assert.equal(
    url.searchParams.get('scope'),
    'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins',
  );
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(pendingLogin.codeVerifier).digest('base64url'));
  assert.equal(url.searchParams.get('state'), pendingLogin.state);
  assert.equal(pendingLogin.subscriptionAccountName, 'Personal');
  assert.equal(pendingLogin.redirectUri, 'http://localhost:4100/callback');
});

test('exchanges a login code for a grant with the account identity', async () => {
  await withFakeTokenServer(
    answerJson(200, {
      access_token: 'login-access-token',
      refresh_token: 'login-refresh-token',
      expires_in: 28800,
      account: { uuid: 'account-uuid-1', email_address: 'person@example.com' },
      organization: { uuid: 'organization-uuid-1' },
    }),
    async ({ endpoints, receivedRequests }) => {
      const { pendingLogin } = startSubscriptionAccountLogin('Personal', 'http://localhost:4100/callback', endpoints);
      const before = Date.now();
      const grant = await exchangeSubscriptionAccountLoginCode(pendingLogin, 'login-code', endpoints);
      assert.deepEqual(receivedRequests.map((request) => request.body), [
        {
          grant_type: 'authorization_code',
          code: 'login-code',
          code_verifier: pendingLogin.codeVerifier,
          state: pendingLogin.state,
          redirect_uri: 'http://localhost:4100/callback',
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        },
      ]);
      const { accessTokenExpiresAt, ...otherFields } = grant;
      assert.deepEqual(otherFields, {
        subscriptionAccountName: 'Personal',
        accountUuid: 'account-uuid-1',
        organizationUuid: 'organization-uuid-1',
        emailAddress: 'person@example.com',
        accessToken: 'login-access-token',
        refreshToken: 'login-refresh-token',
        isRefreshTokenRejected: false,
      });
      assert.ok(Math.abs(accessTokenExpiresAt - (before + 28_800_000)) < 5000);
    },
  );
});

test('throws with the token endpoint error text when the login code is refused', async () => {
  await withFakeTokenServer(answerJson(400, { error: 'invalid_request', error_description: 'bad code' }), async ({ endpoints }) => {
    const { pendingLogin } = startSubscriptionAccountLogin('Personal', 'http://localhost:4100/callback', endpoints);
    await assert.rejects(exchangeSubscriptionAccountLoginCode(pendingLogin, 'bad', endpoints), /bad code/);
  });
});

test('returns the stored token while it is valid for more than 5 minutes', async () => {
  await withFakeTokenServer(answerJson(200, refreshedTokenResponse), async ({ endpoints, receivedRequests }) => {
    await withStore(async (store) => {
      store.writeGrant(personalGrant(Date.now() + 6 * 60_000));
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      assert.equal(await refresher.readAccessToken('Personal'), 'old-access-token');
      assert.equal(receivedRequests.length, 0);
    });
  });
});

test('returns null when the subscription account has no grant', async () => {
  await withFakeTokenServer(answerJson(200, refreshedTokenResponse), async ({ endpoints, receivedRequests }) => {
    await withStore(async (store) => {
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      assert.equal(await refresher.readAccessToken('Personal'), null);
      assert.equal(receivedRequests.length, 0);
    });
  });
});

test('refreshes a token that expires within 5 minutes and stores the rotated refresh token', async () => {
  await withFakeTokenServer(answerJson(200, refreshedTokenResponse), async ({ endpoints, receivedRequests }) => {
    await withStore(async (store) => {
      store.writeGrant(personalGrant(Date.now() + 60_000));
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      assert.equal(await refresher.readAccessToken('Personal'), 'new-access-token');
      assert.deepEqual(receivedRequests.map((request) => request.body), [
        { grant_type: 'refresh_token', refresh_token: 'old-refresh-token', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' },
      ]);
      const storedGrant = store.readGrant('Personal');
      assert.equal(storedGrant?.accessToken, 'new-access-token');
      assert.equal(storedGrant?.refreshToken, 'new-refresh-token');
      assert.equal(storedGrant?.accountUuid, 'account-uuid-1');
      assert.equal(storedGrant?.emailAddress, 'person@example.com');
      assert.ok((storedGrant?.accessTokenExpiresAt ?? 0) > Date.now() + 28_000_000);
    });
  });
});

test('keeps the old refresh token and identity when the refresh response omits them', async () => {
  await withFakeTokenServer(answerJson(200, { access_token: 'new-access-token', expires_in: 28800 }), async ({ endpoints }) => {
    await withStore(async (store) => {
      store.writeGrant(personalGrant(Date.now() - 1000));
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      assert.equal(await refresher.readAccessToken('Personal'), 'new-access-token');
      const storedGrant = store.readGrant('Personal');
      assert.equal(storedGrant?.refreshToken, 'old-refresh-token');
      assert.equal(storedGrant?.organizationUuid, 'organization-uuid-1');
    });
  });
});

test('refreshes once when two requests need a new token at the same moment', async () => {
  await withFakeTokenServer(
    (response) => setTimeout(() => answerJson(200, refreshedTokenResponse)(response), 50),
    async ({ endpoints, receivedRequests }) => {
      await withStore(async (store) => {
        store.writeGrant(personalGrant(Date.now() + 60_000));
        const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
        const accessTokens = await Promise.all([refresher.readAccessToken('Personal'), refresher.readAccessToken('Personal')]);
        assert.deepEqual(accessTokens, ['new-access-token', 'new-access-token']);
        assert.equal(receivedRequests.length, 1);
      });
    },
  );
});

test('marks the grant rejected on invalid_grant and returns null', async () => {
  await withFakeTokenServer(answerJson(400, { error: 'invalid_grant' }), async ({ endpoints, receivedRequests }) => {
    await withStore(async (store) => {
      store.writeGrant(personalGrant(Date.now() - 1000));
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      assert.equal(await refresher.readAccessToken('Personal'), null);
      assert.equal(store.readGrant('Personal')?.isRefreshTokenRejected, true);
      assert.equal(await refresher.readAccessToken('Personal'), null);
      assert.equal(receivedRequests.length, 1);
    });
  });
});

test('keeps the grant on a transient failure', async () => {
  await withFakeTokenServer(answerJson(500, { error: 'server_error' }), async ({ endpoints }) => {
    await withStore(async (store) => {
      store.writeGrant(personalGrant(Date.now() - 1000));
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      await assert.rejects(refresher.readAccessToken('Personal'));
      assert.equal(store.readGrant('Personal')?.isRefreshTokenRejected, false);
      assert.equal(store.readGrant('Personal')?.refreshToken, 'old-refresh-token');
    });
  });
});

test('returns the stored token that is still valid when the refresh fails transiently', async () => {
  await withFakeTokenServer(answerJson(500, { error: 'server_error' }), async ({ endpoints, receivedRequests }) => {
    await withStore(async (store) => {
      store.writeGrant(personalGrant(Date.now() + 2 * 60_000));
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      assert.equal(await refresher.readAccessToken('Personal'), 'old-access-token');
      assert.equal(receivedRequests.length, 1);
      assert.equal(store.readGrant('Personal')?.refreshToken, 'old-refresh-token');
    });
  });
});

test('sends no refresh for 30 seconds after a transient failure, and returns the stored token', async () => {
  await withFakeTokenServer(answerJson(500, { error: 'server_error' }), async ({ endpoints, receivedRequests }) => {
    await withStore(async (store) => {
      store.writeGrant(personalGrant(Date.now() + 2 * 60_000));
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      assert.equal(await refresher.readAccessToken('Personal'), 'old-access-token');
      assert.equal(await refresher.readAccessToken('Personal'), 'old-access-token');
      assert.equal(receivedRequests.length, 1);
    });
  });
});

test('pauses refreshes after a refresh response without an access token, and returns the stored token', async () => {
  await withFakeTokenServer(answerJson(200, { refresh_token: 'new-refresh-token' }), async ({ endpoints, receivedRequests }) => {
    await withStore(async (store) => {
      store.writeGrant(personalGrant(Date.now() + 2 * 60_000));
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      assert.equal(await refresher.readAccessToken('Personal'), 'old-access-token');
      assert.equal(await refresher.readAccessToken('Personal'), 'old-access-token');
      assert.equal(receivedRequests.length, 1);
      assert.equal(store.readGrant('Personal')?.refreshToken, 'old-refresh-token');
    });
  });
});

test('returns null during the refresh pause when the stored token has expired', async () => {
  await withFakeTokenServer(answerJson(500, { error: 'server_error' }), async ({ endpoints, receivedRequests }) => {
    await withStore(async (store) => {
      store.writeGrant(personalGrant(Date.now() - 1000));
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      await assert.rejects(refresher.readAccessToken('Personal'));
      assert.equal(await refresher.readAccessToken('Personal'), null);
      assert.equal(receivedRequests.length, 1);
    });
  });
});

test('refreshes during the refresh pause when a login stored a new grant', async () => {
  await withFakeTokenServer(answerJson(500, { error: 'server_error' }), async ({ endpoints, receivedRequests }) => {
    await withStore(async (store) => {
      store.writeGrant(personalGrant(Date.now() + 2 * 60_000));
      const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
      await refresher.readAccessToken('Personal');
      store.writeGrant({ ...personalGrant(Date.now() + 2 * 60_000), accessToken: 'login-access-token', refreshToken: 'login-refresh-token' });
      assert.equal(await refresher.readAccessToken('Personal'), 'login-access-token');
      assert.equal(receivedRequests.length, 2);
      assert.equal(receivedRequests[1]!.body.refresh_token, 'login-refresh-token');
    });
  });
});

test('drops the result of a refresh when a login stored a new grant while the refresh was in flight', async () => {
  let answerSlowRefresh!: () => void;
  const slowRefreshAnswerGate = new Promise<void>((resolve) => (answerSlowRefresh = resolve));
  const refreshRequestReceived = Promise.withResolvers<void>();
  await withFakeTokenServer(
    (response) => {
      refreshRequestReceived.resolve();
      slowRefreshAnswerGate.then(() => answerJson(200, refreshedTokenResponse)(response));
    },
    async ({ endpoints }) => {
      await withStore(async (store) => {
        store.writeGrant(personalGrant(Date.now() - 1000));
        const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
        const accessTokenPromise = refresher.readAccessToken('Personal');
        await refreshRequestReceived.promise;
        store.writeGrant({
          ...personalGrant(Date.now() + 8 * 60 * 60 * 1000),
          accessToken: 'login-access-token',
          refreshToken: 'login-refresh-token',
        });
        answerSlowRefresh();
        assert.equal(await accessTokenPromise, 'login-access-token');
        assert.equal(store.readGrant('Personal')?.accessToken, 'login-access-token');
        assert.equal(store.readGrant('Personal')?.refreshToken, 'login-refresh-token');
      });
    },
  );
});

test('does not mark a new grant rejected when the refresh of the replaced grant answers invalid_grant', async () => {
  let answerSlowRefresh!: () => void;
  const slowRefreshAnswerGate = new Promise<void>((resolve) => (answerSlowRefresh = resolve));
  const refreshRequestReceived = Promise.withResolvers<void>();
  await withFakeTokenServer(
    (response) => {
      refreshRequestReceived.resolve();
      slowRefreshAnswerGate.then(() => answerJson(400, { error: 'invalid_grant' })(response));
    },
    async ({ endpoints }) => {
      await withStore(async (store) => {
        store.writeGrant(personalGrant(Date.now() - 1000));
        const refresher = new SubscriptionAccountGrantRefresher(store, endpoints);
        const accessTokenPromise = refresher.readAccessToken('Personal');
        await refreshRequestReceived.promise;
        store.writeGrant({
          ...personalGrant(Date.now() + 8 * 60 * 60 * 1000),
          accessToken: 'login-access-token',
          refreshToken: 'login-refresh-token',
        });
        answerSlowRefresh();
        assert.equal(await accessTokenPromise, 'login-access-token');
        assert.equal(store.readGrant('Personal')?.isRefreshTokenRejected, false);
        assert.equal(store.readGrant('Personal')?.refreshToken, 'login-refresh-token');
      });
    },
  );
});
