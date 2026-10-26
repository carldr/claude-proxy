# Subscription account routing: design

## Intent

Carl has two Claude subscriptions:

- **Nettl**, paid for by a client. Claude Code is logged in to this account. Its login email is `carl@29degrees.co.uk`, so do not name it after the email.
- **Personal**, paid for by Carl's own company 29degrees. Carl subscribes to it once this design is approved.

Today Carl does all his work on Nettl, and he hits the weekly limit again and again. With the work split by project, he expects to hit neither limit. When one account does hit a limit, its projects move to the other account without interruption.

The proxy already fails over from the subscription to API keys. That failover goes away. Anthropic's monthly API credits do not apply to Claude Code, so the API keys are of no use.

Both accounts are individual Max plans, with different emails. Extra usage (overage) is off on both. If Carl turns overage on later, an account that uses overage does not fail over. Overage only matters because with it on, an account no longer rejects at its limit.

## Goals

1. Send each Claude Code request to the account that owns its project, chosen by glob patterns on the project directory.
2. Fail over to the other account when an account rejects a request for its 5-hour or weekly limit. Do this before any byte reaches Claude Code, so Claude Code sees a normal response.
3. Keep Remote Control, `/usage`, telemetry and every other non-message call on the account that Claude Code is logged in to. Carl wants all Remote Control sessions under one account on his phone.
4. Show each account's usage at a glance in the menu bar, and in detail in the web UI.

## Non-goals

- Switching the account that Claude Code itself is logged in to. The proxy never touches Claude Code's credentials, Keychain or `~/.claude`.
- Proactive switching at a usage threshold, as `cswap auto` does. Failover happens only on a real rejection. Commit `2ba7f3c` made the API-key failover work the same way, in place of switching at 98% usage.
- Keeping any API-key routing.

## Anti-goals

- Revoking Claude Code's own login. A refresh revokes the previous access token of the same grant at once (claude-swap issue #381, measured). The proxy must never refresh, copy or reuse Claude Code's grant.
- Breaking Remote Control. Swapping the token on `/v1/code/sessions/<id>/worker` puts Remote Control into a reconnect loop (claude-swap issue #198).
- Sending Claude Code a weekly-limit error while the other account still has capacity.

## Evidence the approach works

These questions were settled before the design:

| Question | Answer | Evidence |
| --- | --- | --- |
| Does the server reject a `metadata.user_id` whose `account_uuid` does not match the token? | No. | Tested on 2026-10-26: a random `account_uuid` returned 200, and the usage counted against the token's account. |
| Does a login by the proxy give a grant that is independent of Claude Code's grant? | Yes. | Carl logs in on several machines at once. claude-swap issue #107 runs the same PKCE flow for each account it adds. |
| Does Remote Control work when messages use a different account's token? | Yes. | claude-swap issue #198 measured the reverse split: Remote Control on one account and inference on another, in one session. |

The spike scripts are in the scratchpad, not in the repository. The OAuth constants below come from the Claude Code 2.1.310 binary.

## Decisions

### Accounts and grants

- The proxy runs its own browser OAuth login for every account, Nettl included. Each login gives the proxy a grant of its own, independent of Claude Code's grant.
- The proxy sends every routed `/v1/messages*` request with its own access token for the chosen account. It also polls usage with these grants. It never needs to know which account Claude Code is logged in to.
- The OAuth flow is PKCE with S256, using Claude Code's client:

  | Item | Value |
  | --- | --- |
  | Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
  | Authorize URL | `https://claude.com/cai/oauth/authorize`, with `code=true` |
  | Token URL | `https://platform.claude.com/v1/oauth/token` (JSON body) |
  | Manual redirect URI | `https://platform.claude.com/oauth/code/callback` |
  | Scopes | `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins` |

- A refresh can return a new refresh token. Store it before the new access token is used. The old refresh token stops working when the refresh returns the new one.
- Grants go in SQLite, in a new table. The proxy rewrites them, so they never go in a hand-edited file.

### Configuration file

`~/.claude-proxy/subscription_accounts.yml` replaces `routes.yml`. Carl edits it by hand. The web UI does not edit it.

```yaml
subscription_accounts:
  - name: Nettl
    colour: "#a1c63d"
  - name: Personal
    colour: "#ba8048"
project_routes:
  - project_path_pattern: ~/Development/pdc*
    subscription_account: Nettl
  - project_path_pattern: ~/Development/nettl-dev
    subscription_account: Nettl
default_subscription_account: Personal
```

- `project_routes` are checked in order, and the first match wins. A pattern also matches every subdirectory of a matching directory. `~` expands to the home directory.
- A request whose project matches no pattern goes to `default_subscription_account`. So does a request with no project.
- The project is the directory that Claude Code started in, as `extractProjectPath` reads it today. A request without an environment block uses the project inherited from the earlier request in the session, as `RequestDatabase` does today. Routing must use the inherited project too.
- Failover tries the other accounts in file order.

### Routing a request

- Only OAuth requests to `/v1/messages*` are routed. The proxy replaces the `Authorization: Bearer` header and changes nothing else.
- Every other request goes to `api.anthropic.com` unchanged, with Claude Code's own token. This covers Remote Control, `/api/*`, telemetry and the MCP registry. An `x-api-key` request also goes through unchanged.
- The plan for one request is the project's account first, then the other accounts in file order. An account that is known to be blocked goes to the end of the plan, as the subscription does today. A blocked account may still have a little capacity.

### Failover

- Trigger: a 429 whose rate-limit headers show a rejection by a 5-hour window or by any weekly window. The weekly windows include per-model ones such as Fable's. `readSubscriptionWeeklyRateLimit` now detects only `seven_day*`, and it must also detect `five_hour`.
- On the trigger, the proxy retries the request on the next account in the plan. It does this before it sends anything to Claude Code.
- The account is blocked until the reset time of the window that rejected it.
- *Claude's call:* a rejection by a per-model window, such as Fable's weekly window, blocks only requests for that model on that account. Requests for other models stay on the account. A per-model block does not turn the menu bar pie red. That time comes from the reset header for that window, or else from the usage poll.
- If every account is blocked, Claude Code gets the rejection from the project's own account. Claude Code then shows its normal limit message.
- Any other response, such as a 401, a 5xx or a network error, goes to Claude Code unchanged, with no failover. Both accounts are on the same tier, so a model that one account serves, the other account also serves.
- Two side effects are accepted. The first request on the other account writes the conversation to that account's prompt cache again. The response's rate-limit headers describe the other account, so Claude Code's usage warnings do too.

### Usage

- Every routed response updates its account's usage at once, from its `anthropic-ratelimit-unified-*` headers.
- The proxy polls `GET /api/oauth/usage` with each account's grant every 5 minutes, all the time. This replaces `SubscriptionUsageMonitor`, which polls only while the limit is reached, with the last token Claude Code sent. The response gives 5h, 7d and per-model windows, each with utilisation as a percentage and `resets_at`.

### Menu bar

- One pie per account, in file order, filled in the account's colour. The pie shows the account's weekly (7d) usage. There are no letters.
- The pie turns red when the account is blocked by its weekly limit, so it is full and red. The pie also turns red when the account's 5-hour limit blocks the account. Then the pie keeps showing the weekly percentage.
- Two red pies tell Carl that neither account can take requests.
- When the proxy does not answer, the menu bar keeps today's grey "!" dot.
- The app keeps its refresh timing: once a minute, and every 5 seconds while the proxy does not answer.

### Web UI

- An accounts panel replaces `RoutingPanel` and the routing modes. For each account it shows:
  - the account name, the account email and the colour;
  - a usage bar for 5h, 7d and each per-model window, each with its percentage and the time to reset, as in claude-swap's watch view;
  - whether the account is blocked, and until when;
  - a "Log in" button, which also shows when there is no grant or the grant is dead.
- The Route column shows the account name, with a dot in the account's colour. A failover shows as two attempts on one request, as API-key failovers do today.
- Existing rows keep their old `route_kind` and `route_name` values (`subscription` and the API-key names).

### What goes

- API-key routes: `api_key_routes_config.ts`, `routes.yml` and `default_config/routes.yml`.
- The routing modes `auto`, `force_subscription` and `force_api_key`, and the selected API key, with their web API endpoints and UI.
- The `api_key` route kind for new requests.
- `README.md` and `CLAUDE.md` are updated to describe accounts in place of API keys.

## Left to the builder

- **Login callback.** Prefer a loopback callback, `http://localhost:4100/callback` or the proxy's own path, if the authorization server accepts it. Claude Code itself uses `http://localhost:<random port>/callback`. Otherwise, use the manual redirect and a field in the web UI where Carl pastes the `code#state` string.
- **Account identity.** After login, read the account email and UUID from the token response (`account`, `organization`) or from `/api/oauth/profile`. *Claude's call:* the identity of an account is the pair of account UUID and organisation UUID, because one email can belong to several organisations. Refuse a login whose pair is already stored under another name.
- **Refresh timing.** Refresh shortly before `expiresAt`. Allow one refresh at a time per account. On `invalid_grant`, mark the grant dead and show "Log in" again. A transient failure keeps the grant.
- **An account without a live grant.** Its requests go upstream with Claude Code's own token, unchanged, and the web UI shows that the account needs a login.
- **Database.** The builder designs the grants table and the table for per-account usage and blocked-until times. Use additive `CREATE TABLE IF NOT EXISTS`. Any change to an existing table needs an explicit migration, because `requests.sqlite` holds real data. The old `proxy_settings` keys for routing can stay or be deleted.
- **Status endpoint.** The builder decides the shape of the endpoint that the menu bar and the web UI read.
- **Seeding** `subscription_accounts.yml` from `default_config` on first start, as `routes.yml` is seeded today.
- **Tests** against fake upstream servers, as in `claude_proxy_server.test.ts`. They cover routing by pattern, inherited projects, failover in both directions on 5-hour and weekly rejections, all accounts blocked, and refresh-token rotation.
