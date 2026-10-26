# Subscription Account Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each Claude Code `/v1/messages*` request to the subscription account that owns its project, with a grant that the proxy holds, and fail over to the other account on a 5-hour or weekly limit rejection.

**Architecture:** A hand-edited `subscription_accounts.yml` names the accounts and the project routes. A new SQLite store holds each account's OAuth grant, usage and limit blocks. `SubscriptionAccountRouter` replaces `RoutingState`: it plans the accounts for one request, and `proxy_request_handler.ts` swaps the `Authorization` header per attempt. The API-key routes and the routing modes are removed. The web UI gets an accounts panel with login and usage bars. The menu bar draws one pie per account.

**Tech Stack:** Node 26 with TypeScript type stripping, `node:sqlite`, `node:test`, `yaml`, React with Vite, SwiftUI with AppKit.

**Spec:** `docs/superpowers/specs/2026-10-26-subscription-account-routing-design.md`

## Global Constraints

- Follow `CLAUDE.md`: no parameter properties, enums or namespaces; import with `.ts` extensions; `import type` for types; no new npm packages.
- Every name says the whole thing (user rule): `subscription_account`, not `account`; `SubscriptionAccountRouter`, not `Router`.
- Code comments follow ASD-STE100 sentence rules (user rule): active voice, at most 25 words per sentence.
- Never refresh, copy or read Claude Code's own grant. The proxy uses only grants that it obtained itself.
- Swap the token only on OAuth requests to `/v1/messages*`. Never touch `/v1/code/sessions/*`, `/api/*` or any other path.
- OAuth client ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e`. Authorize URL `https://claude.com/cai/oauth/authorize` with `code=true`. Token URL `https://platform.claude.com/v1/oauth/token`, JSON body. PKCE S256.
- OAuth scopes, exactly: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins`.
- Login redirect URI: `http://localhost:<proxy port>/callback`. Claude Code uses `http://localhost:<random port>/callback`, so the server accepts any localhost port.
- Default colours: Work `#a1c63d`, Personal `#ba8048`. A blocked account shows red `#e5484d`.
- `requests.sqlite` holds real data: new tables use `CREATE TABLE IF NOT EXISTS`; existing tables do not change.
- Usage polling interval: 5 minutes per account with a live grant.
- Commit after each task. Stage files by name. Never push.

## Review Focus

1. A refresh that two requests start at the same moment: the second must wait for the first and use its result. Two refresh calls spend the refresh token twice and kill the grant. Pinned by Task 3 "refreshes once when two requests need a new token at the same moment".
2. A request without an environment block in a `client*` project: it must go to Work through the inherited project, not to the default account. Pinned by Task 5 "routes a request without an environment block by the project it inherits".
3. A per-model rejection (Fable) on Personal: Opus requests from the same project must stay on Personal. Pinned by Task 5 "blocks only the rejected model on a per-model weekly rejection".
4. A malformed `subscription_accounts.yml` (unknown account in a route, duplicate name): the proxy must keep running, report the error in the web UI, and send requests with Claude Code's own token. Pinned by Task 1 "rejects a route to an unknown account" and Task 5 "forwards requests unchanged while subscription_accounts.yml has an error".
5. A login that returns an account already stored under the other name: refuse it, so one account cannot appear twice. Pinned by Task 7 "refuses a login whose account is stored under another name".

---

### Task 1: Subscription accounts configuration file

**Files:**
- Create: `packages/claude_proxy_server/src/subscription_accounts_config.ts`
- Create: `packages/claude_proxy_server/default_config/subscription_accounts.yml`
- Create: `packages/claude_proxy_server/test/subscription_accounts_config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SubscriptionAccount { name: string; colour: string }
  export interface ProjectRoute { projectPathPattern: string; subscriptionAccountName: string }
  export interface SubscriptionAccountsConfig {
    subscriptionAccounts: SubscriptionAccount[];
    projectRoutes: ProjectRoute[];
    defaultSubscriptionAccountName: string | null;
  }
  export const emptySubscriptionAccountsConfig: SubscriptionAccountsConfig;
  export function parseSubscriptionAccountsConfig(yamlValue: unknown, homeDirectory: string): SubscriptionAccountsConfig;
  export function findSubscriptionAccountNameForProject(config: SubscriptionAccountsConfig, projectPath: string | null): string | null;
  ```

- [ ] **Step 1: Write the failing tests** in `subscription_accounts_config.test.ts`:
  - `parses accounts, routes and the default account, and expands ~`: parsing the spec's example YAML with `homeDirectory` `/Users/example_user` gives `projectRoutes[0].projectPathPattern === '/Users/example_user/Development/client*'`, two accounts with their colours, and `defaultSubscriptionAccountName === 'Personal'`.
  - `matches a pattern and every subdirectory of a match`: `/Users/example_user/Development/client_project` and `/Users/example_user/Development/client_project/src/deep` give `'Work'`; `/Users/example_user/Development/work-dev` gives `'Work'`; `/Users/example_user/Development/work-dev-old` gives `'Personal'`.
  - `uses the first matching route`: with routes `~/Development/*` → Personal before `~/Development/client*` → Work, `/Users/example_user/Development/client_x` gives `'Personal'`.
  - `gives the default account to an unmatched project and to a request with no project`: `/tmp/other` and `null` give `'Personal'`.
  - `rejects a route to an unknown account`: throws `/project_routes\[0\]\.subscription_account "Nobody" is not in subscription_accounts/`.
  - `rejects two accounts with one name`: throws `/two accounts named "Work"/`.
  - `treats an empty file as no accounts`: `parseSubscriptionAccountsConfig(null, home)` deep-equals `emptySubscriptionAccountsConfig`.

- [ ] **Step 2: Run** `node --test packages/claude_proxy_server/test/subscription_accounts_config.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** `subscription_accounts_config.ts`. Validate in the same style as `api_key_routes_config.ts`: non-empty string fields, error messages that name the YAML path. `default_subscription_account` is optional, and when it is set it must name a listed account. Match with `path.matchesGlob(candidatePath, pattern)` against the project path and each of its ancestor directories, so a pattern also covers subdirectories.

- [ ] **Step 4: Write** `default_config/subscription_accounts.yml` with the spec's example, plus a header comment. The comment says what each key does, that the first matching route wins, and that accounts log in from the web UI.

- [ ] **Step 5: Run** the test file again. Expected: PASS.

- [ ] **Step 6: Commit** `git commit -m "Add the subscription accounts configuration file and project route matching"`

### Task 2: Subscription account store

**Files:**
- Create: `packages/claude_proxy_server/src/subscription_account_store.ts`
- Create: `packages/claude_proxy_server/test/subscription_account_store.test.ts`
- Modify: `packages/claude_proxy_server/src/request_database.ts` (make `assignProjectPath` public as `findProjectPath`)

**Interfaces:**
- Produces:
  ```ts
  export interface SubscriptionAccountGrant {
    subscriptionAccountName: string;
    accountUuid: string;
    organizationUuid: string | null;
    emailAddress: string | null;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: number; // epoch milliseconds
    isRefreshTokenRejected: boolean;
  }
  export interface SubscriptionAccountUsageWindow {
    usageWindowName: string; // '5h', '7d', or a model display name such as 'Fable'
    utilization: number;     // fraction from 0 to 1
    resetsAt: string | null; // ISO 8601
  }
  export interface SubscriptionAccountLimitBlock {
    subscriptionAccountName: string;
    blockedModel: string;    // '' blocks every model
    rateLimitWindow: string; // the representative claim, such as 'five_hour', 'seven_day', 'seven_day_fable'
    blockedUntil: string;    // ISO 8601
  }
  export class SubscriptionAccountStore {
    constructor(databasePath: string);
    readGrant(subscriptionAccountName: string): SubscriptionAccountGrant | null;
    findGrantByAccountIdentity(accountUuid: string, organizationUuid: string | null): SubscriptionAccountGrant | null;
    writeGrant(grant: SubscriptionAccountGrant): void;
    readUsageWindows(subscriptionAccountName: string): { usageWindows: SubscriptionAccountUsageWindow[]; checkedAt: string | null };
    mergeUsageWindows(subscriptionAccountName: string, usageWindows: SubscriptionAccountUsageWindow[], checkedAt: string): void;
    writeLimitBlock(limitBlock: SubscriptionAccountLimitBlock): void;
    /** Deletes blocks whose blockedUntil has passed, then returns the rest. */
    readActiveLimitBlocks(now: Date): SubscriptionAccountLimitBlock[];
    deleteLimitBlocks(subscriptionAccountName: string, blockedModel: string): void;
    close(): void;
  }
  ```
  `RequestDatabase.findProjectPath(sessionId: string | null, projectPath: string | null, previousUpstreamRequestId: string | null): { projectPath: string | null; isProjectPathInherited: boolean }`.
- [ ] **Step 1: Write the failing tests** in `subscription_account_store.test.ts`, each on a temporary database file:
  - `stores a grant and finds it by account identity`: `writeGrant` then `readGrant('Personal')` deep-equals the input, and `findGrantByAccountIdentity(uuid, orgUuid)` returns it.
  - `replaces a grant on a second write`: a second `writeGrant` with a new `refreshToken` makes `readGrant` return the new token.
  - `merges usage windows by name`: `mergeUsageWindows` with `5h` and `7d`, then with only `7d` at a new value, keeps `5h` and updates `7d`.
  - `expires limit blocks at blockedUntil`: a block until `now + 1 h` is returned; with `now + 2 h` passed to `readActiveLimitBlocks`, the result is empty.
  - `keeps a whole-account block and a model block apart`: blocks with `blockedModel` `''` and `'claude-fable-5-1'` both come back, and `deleteLimitBlocks('Personal', '')` removes only the first.

- [ ] **Step 2: Run** `node --test packages/claude_proxy_server/test/subscription_account_store.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `SubscriptionAccountStore`. It opens its own `DatabaseSync` on `requests.sqlite` with `journal_mode = WAL` and `busy_timeout = 5000`. It creates three tables with `CREATE TABLE IF NOT EXISTS`:
  - `subscription_account_grants`, primary key `subscription_account_name`;
  - `subscription_account_usage_windows`, primary key `(subscription_account_name, usage_window_name)`, with a `checked_at` column;
  - `subscription_account_limit_blocks`, primary key `(subscription_account_name, blocked_model)`.

  Keep the private `assignProjectPath` unchanged, because the migration passes a request ID to it. Add the public `findProjectPath`, which calls `assignProjectPath` with `Number.MAX_SAFE_INTEGER`, as `insertStartedRequest` does.

- [ ] **Step 4: Run** the new test file and `pnpm test`. Expected: PASS, with the existing inheritance test still passing.

- [ ] **Step 5: Commit** `git commit -m "Add the store for subscription account grants, usage and limit blocks"`

### Task 3: OAuth client and grant refresh

**Files:**
- Create: `packages/claude_proxy_server/src/subscription_account_oauth.ts`
- Create: `packages/claude_proxy_server/test/subscription_account_oauth.test.ts`

**Interfaces:**
- Consumes: `SubscriptionAccountStore`, `SubscriptionAccountGrant` (Task 2).
- Produces:
  ```ts
  export interface OAuthEndpoints { authorizeUrl: string; tokenUrl: string } // tests point tokenUrl at a fake server
  export const anthropicOAuthEndpoints: OAuthEndpoints;
  export interface PendingSubscriptionAccountLogin { subscriptionAccountName: string; codeVerifier: string; state: string; redirectUri: string }
  export function startSubscriptionAccountLogin(subscriptionAccountName: string, redirectUri: string, endpoints: OAuthEndpoints):
    { pendingLogin: PendingSubscriptionAccountLogin; authorizeUrl: string };
  /** Exchanges the code, and returns the grant without storing it. Throws with the token endpoint's error text. */
  export function exchangeSubscriptionAccountLoginCode(pendingLogin: PendingSubscriptionAccountLogin, code: string, endpoints: OAuthEndpoints):
    Promise<SubscriptionAccountGrant>;
  export class SubscriptionAccountGrantRefresher {
    constructor(subscriptionAccountStore: SubscriptionAccountStore, endpoints: OAuthEndpoints);
    /** Returns a live access token, refreshing first when it expires within 5 minutes. Null when there is no live grant. */
    readAccessToken(subscriptionAccountName: string): Promise<string | null>;
  }
  ```

- [ ] **Step 1: Write the failing tests** in `subscription_account_oauth.test.ts`, with a fake token server built as in `claude_proxy_server.test.ts`:
  - `builds the authorize URL with PKCE and the Claude Code client`: the URL has `code=true`, the client ID, `response_type=code`, the redirect URI, the scopes from Global Constraints, `code_challenge_method=S256`, and a `code_challenge` equal to base64url SHA-256 of `pendingLogin.codeVerifier`.
  - `exchanges a login code for a grant with the account identity`: the fake server receives `grant_type: 'authorization_code'`, `code`, `code_verifier`, `state`, `redirect_uri` and `client_id`. It answers `{ access_token, refresh_token, expires_in: 28800, account: { uuid, email_address }, organization: { uuid } }`. The returned grant carries those values, with `accessTokenExpiresAt` about now + 28 800 000 ms.
  - `returns the stored token while it is valid for more than 5 minutes`: the fake server receives no request.
  - `refreshes a token that expires within 5 minutes and stores the rotated refresh token`: `readAccessToken` returns the new access token, and `store.readGrant` has the new refresh token.
  - `refreshes once when two requests need a new token at the same moment`: two concurrent `readAccessToken` calls give the same token, and the fake server receives one request.
  - `marks the grant rejected on invalid_grant and returns null`: a 400 response with `{"error":"invalid_grant"}` sets `isRefreshTokenRejected`, and `readAccessToken` returns `null` then and on the next call, with no second request.
  - `keeps the grant on a transient failure`: a 500 response throws, and `isRefreshTokenRejected` stays `false`.

- [ ] **Step 2: Run** `node --test packages/claude_proxy_server/test/subscription_account_oauth.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** with `node:crypto` (`randomBytes(32)`, base64url, `createHash('sha256')`) and `fetch` with `AbortSignal.timeout(30_000)`. Keep one in-flight refresh promise per account in a `Map<string, Promise<string | null>>`. Delete the entry when the promise settles. Write the rotated grant to the store before resolving.

- [ ] **Step 4: Run** the test file. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Add the OAuth login and grant refresh for subscription accounts"`

### Task 4: Rate limit header reading

**Files:**
- Modify: `packages/claude_proxy_server/src/subscription_rate_limit_headers.ts` (replace its contents)
- Create: `packages/claude_proxy_server/test/subscription_rate_limit_headers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SubscriptionRateLimitRejection {
    rateLimitWindow: string;     // the representative claim
    isModelWindow: boolean;      // true for a per-model weekly claim
    blockedUntil: Date;
  }
  export interface SubscriptionRateLimit {
    usageWindows: SubscriptionAccountUsageWindow[]; // '5h' and '7d' from the headers that are present
    rejection: SubscriptionRateLimitRejection | null;
  }
  export function readSubscriptionRateLimit(statusCode: number, responseHeaders: IncomingHttpHeaders, now: Date): SubscriptionRateLimit;
  ```

- [ ] **Step 1: Write the failing tests**, using the header names that Anthropic sends today (`anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}`, `-status`, `-representative-claim`, `-reset`):
  - `reads 5h and 7d usage from an allowed response`: `5h-utilization 0.09`, `7d-utilization 0.93` and their resets give two windows, and `rejection` is `null`.
  - `reads a five-hour rejection`: a 429 with `status: rejected`, claim `five_hour` and `5h-reset` gives `{ rateLimitWindow: 'five_hour', isModelWindow: false }`, with `blockedUntil` equal to the 5h reset.
  - `reads a weekly rejection`: claim `seven_day` gives `isModelWindow: false`, with `blockedUntil` from `7d-reset`.
  - `reads a per-model weekly rejection`: claim `seven_day_fable` gives `isModelWindow: true`, with `blockedUntil` from `anthropic-ratelimit-unified-reset`.
  - `treats a 429 without a rejected status, and a 529, as no rejection`.
  - `blocks for one hour when the rejection names no reset time`.

- [ ] **Step 2: Run** the test file. Expected: FAIL.

- [ ] **Step 3: Implement.** A rejection needs status 429 and either `status: rejected` or `<window>-status: rejected`. The claim `five_hour` or `seven_day` is a whole-account window. Any other claim that starts with `seven_day_` is a model window. Reset order: the window's own reset header, then `-reset`, then `now + 1 h`.

- [ ] **Step 4: Run** the test file. Expected: PASS. `proxy_request_handler.ts` and `routing_state.ts` still import the old function, so leave `pnpm typecheck` failing until Task 5.

- [ ] **Step 5: Commit** `git commit -m "Read 5-hour, weekly and per-model limit rejections from the rate limit headers"`

### Task 5: Route requests between subscription accounts, and remove API-key routing

**Files:**
- Create: `packages/claude_proxy_server/src/subscription_account_router.ts`
- Modify: `packages/claude_proxy_server/src/proxy_request_handler.ts`
- Modify: `packages/claude_proxy_server/src/claude_proxy_server.ts`
- Modify: `packages/claude_proxy_server/src/request_database.ts:5` (`RouteKind`)
- Modify: `packages/claude_proxy_server/src/web_api_handler.ts` (remove `routing-settings`; Task 6 replaces `routing-status`)
- Delete: `src/routing_state.ts`, `src/api_key_routes_config.ts`, `default_config/routes.yml`
- Test: `packages/claude_proxy_server/test/claude_proxy_server.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces:
  ```ts
  export type RouteKind = 'subscription_account' | 'subscription' | 'api_key' | 'passthrough'; // the old kinds stay for old rows
  export interface PlannedSubscriptionAccountRoute { subscriptionAccountName: string; accessToken: string | null } // null: send Claude Code's own token
  export class SubscriptionAccountRouter {
    constructor(subscriptionAccountStore: SubscriptionAccountStore, grantRefresher: SubscriptionAccountGrantRefresher,
                readSubscriptionAccountsConfig: () => SubscriptionAccountsConfig);
    planRoutes(projectPath: string | null, model: string | null, now: Date): Promise<PlannedSubscriptionAccountRoute[]>;
    recordResponse(subscriptionAccountName: string, model: string | null, rateLimit: SubscriptionRateLimit): void;
  }
  ```
  `createClaudeProxyServer` gets an option `oauthEndpoints: OAuthEndpoints` (main.ts passes `anthropicOAuthEndpoints`), and returns `subscriptionAccountStore` and `subscriptionAccountRouter` in place of `routingState`.

- [ ] **Step 1: Rewrite the test harness.** `startProxy(respondAsAnthropic, subscriptionAccountsYaml)` writes `subscription_accounts.yml`, and starts one fake upstream named `anthropic` plus a fake token server. A helper `storeTestGrant(subscriptionAccountName, accessToken)` writes a grant that expires in 8 hours. The upstream responder tells accounts apart by `headers.authorization`: `Bearer work-token`, `Bearer personal-token`, or Claude Code's `Bearer sk-ant-oat-test`. Delete the API-key and routing-mode tests: `moves to the API key…`, `keeps the subscription at 100%…`, `does not switch on a 429 for the five-hour window…`, `tries the next API key on a 401…`, `starts with the selected API key…`.

- [ ] **Step 2: Write the failing tests** in `claude_proxy_server.test.ts`. The YAML routes `/Users/example_user/Development/client*` to Work, with Personal as the default.
  - `sends a project's requests with its account's grant and records the account`: a request with the default body (project `/Users/example_user/Development/example_project`) reaches upstream with `Bearer personal-token`. `x-claude-proxy-route` is `Personal`, and the recorded `route_kind` is `subscription_account`.
  - `routes a client project to Work`: a body whose environment block names `/Users/example_user/Development/client_project` reaches upstream with `Bearer work-token`.
  - `routes a request without an environment block by the project it inherits`: a `client_project` request answered with a `request-id: req_1` header, then a request with no environment block and `cc_prev_req=req_1` in `system`, go out with `work-token` both times.
  - `fails over on a weekly rejection and stays on the other account until the reset`: Personal answers 429 with weekly rejection headers. The client gets 200 from Work, and two attempts are recorded. The next request goes straight to Work.
  - `fails over on a five-hour rejection, in the other direction`: a `client` request, with Work answering a `five_hour` rejection, is answered by Personal.
  - `blocks only the rejected model on a per-model weekly rejection`: Personal rejects `claude-fable-5-1` with claim `seven_day_fable`. Then a `claude-opus-5-5` request from the same project goes to Personal first.
  - `returns the project's own rejection when every account is blocked`: both accounts reject. The first request gets the rejection of the account tried last, and both are recorded as attempts. A second request is planned as `[Personal]` only, and gets Personal's 429.
  - `forwards a 401, a 529 and a network error without failover`: each reaches the client with one attempt recorded.
  - `sends Claude Code's own token for an account without a grant, and never fails over to it`: no grant for Personal. A default-project request reaches upstream with `Bearer sk-ant-oat-test`, and a Work rejection does not move to Personal.
  - `forwards requests unchanged while subscription_accounts.yml has an error`: an unknown account in a route gives Claude Code's own token upstream, and `configErrors` is non-empty.
  - `leaves every non-message path untouched`: `/v1/code/sessions/cse_1/worker/heartbeat` and `/api/oauth/profile` reach upstream with Claude Code's own `authorization`, and with no `x-claude-proxy-route` header.
  - Keep the passing tests for recording, inheritance, cost totals, local-request checks, unrecorded paths and `x-api-key` passthrough, adapted to the new harness.

- [ ] **Step 3: Run** `pnpm test`. Expected: the new tests FAIL.

- [ ] **Step 4: Implement `SubscriptionAccountRouter.planRoutes`.**

  ```text
  config has an error or no accounts           -> []   (handler sends Claude Code's own token, route kind 'subscription')
  ownAccount = findSubscriptionAccountNameForProject(config, projectPath)
  preference = [ownAccount, ...other accounts in file order]
  isBlocked(account) = an active block for (account, '') or for (account, model)
  usable = preference filtered to accounts that are not blocked and have a live access token
  plan = usable, then ownAccount appended when ownAccount is blocked
  ownAccount without a live grant -> it stays first in the plan, with accessToken null
  ```

  When every account rejects the first request, Claude Code gets the rejection of the account tried last. The spec's rule, the project's own rejection, applies from the second request on, once the blocks are stored. That is Claude's call, because it avoids holding a rejected response open while the next attempt runs.

  `recordResponse` merges `rateLimit.usageWindows` into the store. On a rejection it writes a block, with `blockedModel` `''` for a whole-account window, or the request's model for a model window.

- [ ] **Step 5: Change `handleProxyRequest`.** Resolve the project with `requestDatabase.findProjectPath(...)` before planning. For each attempt, `buildUpstreamHeaders` sets `authorization: Bearer <accessToken>` when the token is not null. Fail over only on `rateLimit.rejection !== null`. Record `routeKind: 'subscription_account'` and `routeName: subscriptionAccountName`. An OAuth request outside `/v1/messages*` keeps `routeKind: 'subscription'`, `routeName: 'subscription'` and the client's header. Remove `rememberSubscriptionAccessToken` and the API-key header rewriting.

- [ ] **Step 6: Wire `claude_proxy_server.ts`.** Seed `subscription_accounts.yml` and `pricing.yml` from `default_config` instead of `routes.yml`. Build the store, the refresher and the router. Report `subscription_accounts.yml` load errors through `readConfigErrors`. Close the store in `close()`. Delete `routing_state.ts`, `api_key_routes_config.ts` and `default_config/routes.yml`, and leave a user's existing `~/.claude-proxy/routes.yml` untouched.

- [ ] **Step 7: Run** `pnpm test` and `pnpm --filter claude_proxy_server typecheck`. Expected: PASS. The web UI typecheck still fails until Task 8.

- [ ] **Step 8: Commit** `git commit -m "Route Claude Code requests between subscription accounts by project, with failover on 5-hour and weekly limits"`

### Task 6: Usage polling and the subscription account status endpoint

**Files:**
- Modify: `packages/claude_proxy_server/src/subscription_usage_monitor.ts` → rename to `subscription_account_usage_monitor.ts`
- Modify: `packages/claude_proxy_server/src/web_api_handler.ts`, `src/claude_proxy_server.ts`, `src/main.ts`
- Test: `packages/claude_proxy_server/test/claude_proxy_server.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class SubscriptionAccountUsageMonitor {
    constructor(subscriptionAccountStore: SubscriptionAccountStore, grantRefresher: SubscriptionAccountGrantRefresher,
                readSubscriptionAccountsConfig: () => SubscriptionAccountsConfig, anthropicBaseUrl: string);
    start(): void; // every 5 minutes
    stop(): void;
    /** Polls every account with a live grant. Returns one error message per failed account. */
    checkAllSubscriptionAccountUsage(): Promise<string[]>;
  }
  export function parseSubscriptionAccountUsageReport(usageReport: unknown): SubscriptionAccountUsageWindow[];
  ```
  `GET /_proxy/api/subscription-account-status` returns:
  ```ts
  interface SubscriptionAccountStatus {
    subscriptionAccounts: Array<{
      subscriptionAccountName: string; colour: string; emailAddress: string | null;
      loginState: 'logged_in' | 'login_required';
      weeklyUtilization: number | null;      // the '7d' window
      isBlocked: boolean;                    // a whole-account block only
      blockedUntil: string | null;
      usageWindows: SubscriptionAccountUsageWindow[]; usageCheckedAt: string | null;
    }>;
    configErrors: string[];
  }
  ```
  `POST /_proxy/api/subscription-account-usage-check` runs `checkAllSubscriptionAccountUsage()`, and returns the status with `usageCheckErrors: string[]`.

- [ ] **Step 1: Write the failing tests:**
  - `parses five_hour, seven_day and per-model windows from the usage report`: `{ five_hour: { utilization: 9, resets_at }, seven_day: { utilization: 93, resets_at }, limits: [{ scope: { model: { display_name: 'Fable' } }, percent: 59, resets_at }] }` gives `5h 0.09`, `7d 0.93` and `Fable 0.59`.
  - `polls each logged-in account with its own grant`: the fake upstream receives `GET /api/oauth/usage` once with `work-token` and once with `personal-token`. The status endpoint then shows both accounts' `weeklyUtilization`.
  - `clears a whole-account block when the usage poll shows room again`: a stored weekly block for Personal, plus a poll that reports `seven_day.utilization: 40`, gives `isBlocked: false`.
  - `reports login_required for an account without a grant or with a rejected refresh token`.
  - `updates usage from the headers of every routed response`: after one Personal response with `7d-utilization 0.5`, the status shows `weeklyUtilization: 0.5`.

- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.

- [ ] **Step 3: Implement** the monitor. The request headers are those of the current `SubscriptionUsageMonitor`. A whole-account block is cleared when the polled window it names (`five_hour` for `5h`, `seven_day` for `7d`) is below 100%. Replace the `routing-status` and `subscription-usage-check` endpoints. `main.ts` starts the new monitor and runs one check at startup.

- [ ] **Step 4: Run** `pnpm test` and the server typecheck. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Poll every subscription account's usage with its own grant, and serve the account status"`

### Task 7: Log in to a subscription account from the web UI

**Files:**
- Modify: `packages/claude_proxy_server/src/web_api_handler.ts`
- Modify: `packages/claude_proxy_server/src/claude_proxy_server.ts` (route `GET /callback`)
- Test: `packages/claude_proxy_server/test/claude_proxy_server.test.ts`

**Interfaces:**
- Consumes: `startSubscriptionAccountLogin`, `exchangeSubscriptionAccountLoginCode` (Task 3).
- Produces:
  - `POST /_proxy/api/subscription-accounts/<name>/login` → `{ authorizeUrl }`. The proxy keeps the pending login in memory, keyed by `state`, for 10 minutes.
  - `GET /callback?code=…&state=…` on the loopback listener: exchanges the code, stores the grant under the pending login's account name, and answers `302` to `/_proxy/`. An error answers `400` with plain text that names the cause.

- [ ] **Step 1: Write the failing tests:**
  - `logs in an account through the loopback callback`: POST login for `Personal`, then GET `/callback` with the URL's `state` and a code. The fake token server answers with an identity. `readGrant('Personal')` then holds the tokens, and the status shows `loginState: 'logged_in'` with the email.
  - `refuses a login whose account is stored under another name`: Work's grant has `accountUuid` A. A Personal login whose token response has `account.uuid` A answers 400 with `/already logged in as Work/`, and stores nothing.
  - `rejects a callback with an unknown state`: answers 400, and nothing is stored.
  - `rejects a login for an account that is not in subscription_accounts.yml`: the POST answers 400.

- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.

- [ ] **Step 3: Implement.** The redirect URI is `http://localhost:<listening port>/callback`. In `dispatchRequest`, send `GET /callback` to the login handler before the 404 branch. Add a comment that the path must be `/callback` because Claude Code's OAuth client registers that path.

- [ ] **Step 4: Run** `pnpm test` and the server typecheck. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Log in to subscription accounts from the web UI through a loopback OAuth callback"`

### Task 8: Web UI accounts panel and Route column

**Files:**
- Create: `packages/claude_proxy_web_ui/src/SubscriptionAccountsPanel.tsx`
- Delete: `packages/claude_proxy_web_ui/src/RoutingPanel.tsx`
- Modify: `src/claude_proxy_api.ts`, `src/ClaudeProxyApplication.tsx`, `src/RouteDot.tsx`, `src/CostSummaryView.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: the endpoints of Tasks 6 and 7.
- Produces: `claudeProxyApi.readSubscriptionAccountStatus()`, `checkSubscriptionAccountUsage()`, `startSubscriptionAccountLogin(name): Promise<{ authorizeUrl: string }>`. `RouteDotAppearance.letter` becomes optional.

- [ ] **Step 1: Replace the routing types** in `claude_proxy_api.ts` with `SubscriptionAccountStatus` from Task 6, and the three API calls above. Remove `RoutingMode`, `RoutingStatus` and `updateRoutingSettings`.

- [ ] **Step 2: Build `SubscriptionAccountsPanel`.** It shows one card per account, in file order:
  - a header with a dot in the account's colour, the account name and the email;
  - one bar per usage window, in the order 5h, 7d, then the model windows. Each bar has its percentage and "resets in 2h 47m" text. A bar at 100% is red.
  - "Blocked until <time>" when `isBlocked`;
  - a "Log in" button when `loginState` is `login_required`, plus a "Log in again" text button otherwise. Both open `authorizeUrl` in a new tab.

  The panel also has a "Check usage now" button, and the config errors list as today.

- [ ] **Step 3: Update `ClaudeProxyApplication.findRouteAppearance`.** An account name gives its colour with no letter. `subscription` gives the existing white `S`, and `passthrough` the existing grey `K`. Any other name, such as an old API-key route, gives the grey `?`. Poll `readSubscriptionAccountStatus` every 5 seconds, as today. In `CostSummaryView`, describe `subscription_account` and `subscription` rows as "At API prices, not billed".

- [ ] **Step 4: Run** `pnpm typecheck` and `pnpm --filter claude_proxy_web_ui build`. Expected: PASS.

- [ ] **Step 5: Check in the browser** with Claude in Chrome (never Playwright), against `pnpm dev:server` and `pnpm dev:web_ui` on a scratch `CLAUDE_PROXY_DIRECTORY`. Two cards should show, each with "Log in". The Route column should show coloured dots. Take a screenshot.

- [ ] **Step 6: Commit** `git commit -m "Show subscription accounts with usage bars and login in the web UI"`

### Task 9: Menu bar pies

**Files:**
- Modify: `macos/claude_proxy_menu_bar/ClaudeProxyMenuBar.swift`

**Interfaces:**
- Consumes: `GET /_proxy/api/subscription-account-status` (Task 6).

- [ ] **Step 1: Replace `RoutingStatus`** with a `Decodable` `SubscriptionAccountStatus` holding the fields that the menu bar needs: `subscriptionAccountName`, `colour`, `weeklyUtilization`, `isBlocked`, `loginState`.

- [ ] **Step 2: Replace `makeRouteDotImage`** with `makeSubscriptionAccountPiesImage(subscriptionAccounts:) -> NSImage`. It draws one 16-point circle per account, 4 points apart, as a non-template image. Each circle has a faint fill of the account colour at 25% alpha, a pie wedge from 12 o'clock clockwise for `weeklyUtilization`, and a 1-point dark outline. A blocked account draws its wedge and faint fill in red `#e5484d`. An account that requires login draws an empty grey circle. When the proxy does not answer, keep the grey "!" dot.

- [ ] **Step 3: Replace the menu text.** Show one line per account: "Work: 93% weekly", "Personal: blocked until Tue 14:00", or "Personal: log in from the web UI". Remove the routing mode line.

- [ ] **Step 4: Run** `sh macos/claude_proxy_menu_bar/build_claude_proxy_menu_bar.sh`. Expected: the build succeeds.

- [ ] **Step 5: Commit** `git commit -m "Show one weekly usage pie per subscription account in the menu bar"`

### Task 10: Documentation and the end-to-end check

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Update `README.md` and `CLAUDE.md`.** Replace every description of API-key routes, `routes.yml`, routing modes and the weekly switch to API keys. Describe instead:
  - `subscription_accounts.yml`;
  - login from the web UI;
  - the proxy's own grants;
  - the token swap on `/v1/messages*` only;
  - failover on 5-hour and weekly limits;
  - the menu bar pies.

  In CLAUDE.md "Request flow", rewrite steps 2 to 4. Add to "Facts checked against real Claude Code traffic" the facts the spec measured: a mismatched `metadata.user_id` is accepted, and refreshing a grant revokes that grant's previous access token.

- [ ] **Step 2: Run** `pnpm test`, `pnpm typecheck` and `pnpm build`. Expected: PASS.

- [ ] **Step 3: Commit** `git commit -m "Describe subscription account routing in the README and CLAUDE.md"`

- [ ] **Step 4: Hand over to the user for the end-to-end check.** These steps need the user's browser logins and second subscription:
  1. Run `launchctl kickstart -k gui/$(id -u)/local.claude-proxy.server`, and open `http://127.0.0.1:4100/_proxy/`.
  2. Log in to Work, then Personal, each in a browser signed in to that account.
  3. Run `claude` in `~/Development/client_project` and in this repository, and check the Route column shows Work and Personal.
  4. Start Remote Control from the Personal project, and check that the session opens on the phone under Work.
