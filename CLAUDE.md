# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

claude-proxy is a local proxy for Claude Code on `127.0.0.1:4100`. It records `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` and `/api/hello` in SQLite, and forwards every other path unrecorded. It sends each project's `/v1/messages` requests to one of several Claude subscription accounts, and moves a request to another account when an account is at a limit. `README.md` describes the behaviour for users.

## Commands

| Command | Action |
| --- | --- |
| `pnpm test` | Runs the server tests (`node --test`) against fake upstream HTTP servers. |
| `node --test --test-name-pattern="weekly limit" packages/claude_proxy_server/test/claude_proxy_server.test.ts` | Runs the tests whose names match the pattern. |
| `pnpm typecheck` | Runs `tsc --noEmit` in both packages. There is no linter. |
| `pnpm build` | Builds the web UI into `packages/claude_proxy_web_ui/dist` and the menu bar app into `macos/claude_proxy_menu_bar/build`. |
| `pnpm dev:server` / `pnpm dev:web_ui` | Runs the proxy with `--watch`, or the Vite dev server with `/_proxy/api` sent to port 4100. |
| `launchctl kickstart -k gui/$(id -u)/local.claude-proxy.server` | Restarts the installed proxy after a server change. Run `pnpm build` first if the web UI changed. |

To test against the real API without touching the installed proxy or `~/.claude-proxy`, start a second instance and send Claude Code through it:

```sh
CLAUDE_PROXY_DIRECTORY=<scratch dir> CLAUDE_PROXY_PORT=4199 node packages/claude_proxy_server/src/main.ts &
ANTHROPIC_BASE_URL=http://127.0.0.1:4199 claude -p "Reply with the single word: pong"
```

## How the server is built

- Node runs the TypeScript source directly with type stripping, so the server has no build step. `tsconfig.json` sets `erasableSyntaxOnly`. Do not use parameter properties, enums or namespaces. Import with `.ts` extensions, and use `import type` for types.
- The database is `node:sqlite`. Bodies are compressed with `node:zlib` zstd. Do not add `better-sqlite3`.
- `RequestDatabase` creates its schema with `CREATE ... IF NOT EXISTS` and has no migrations. `~/.claude-proxy/requests.sqlite` holds real data, so a schema change needs an explicit migration.

## Request flow

Claude Code reaches the proxy as its `HTTPS_PROXY`. `https_proxy_connect_handler.ts` answers each `CONNECT`:

- For `api.anthropic.com:443`, it decrypts the connection with the mkcert certificate in `~/.claude-proxy/api.anthropic.com.pem`. It gives the decrypted connection to `interceptedAnthropicApiServer`, which sends every path to `proxy_request_handler.ts`. If the certificate is missing, it answers 502.
- For any other host, it opens a TCP tunnel and does not record it.

Do not change the setup back to `ANTHROPIC_BASE_URL`. Claude Code turns off Remote Control when `ANTHROPIC_BASE_URL` is not `api.anthropic.com`. The loopback listener still accepts `ANTHROPIC_BASE_URL` requests, as follows.

`claude_proxy_server.ts` checks every request on the loopback listener with `isLocalRequest`. The Host must be `127.0.0.1` or `localhost` on the proxy port, and the Origin must be absent or the proxy's own. It then sends the request to one of three handlers:

- `/_proxy/api/*` goes to `web_api_handler.ts`.
- `/_proxy/*` goes to `web_ui_static_file_handler.ts`.
- `/v1/*` and `/api/*` go to `proxy_request_handler.ts`.
- Every other path gets a local 404 and is not recorded.

`handleProxyRequest` does the following:

1. It classifies the client auth. `Authorization: Bearer` is a subscription OAuth token, and `x-api-key` is passthrough.
2. Only OAuth requests to `/v1/messages*` follow `SubscriptionAccountRouter.planRoutes()`. All other requests go to `api.anthropic.com` unchanged, with Claude Code's own token.
3. `planRoutes` puts the project's own subscription account first, then the other accounts in file order. The project comes from `RequestDatabase.findProjectPath`, so an inherited project counts. A rejection for the 5-hour window or the weekly window blocks the account. A rejection for the weekly window of one model blocks only that model on that account. A rejection-blocked account goes to the end of the plan, after every account that is not blocked, because a block can end early. The plan omits an account whose 5-hour or weekly utilization is at or above its own `failover_utilization`. The project's own account is the exception: it goes last, after the rejection-blocked accounts, as the last resort. An account without a live grant is not a failover target. When the project lookup or `planRoutes` throws, the handler logs the error and sends the request with Claude Code's own token.
4. The handler tries the planned routes in order. It moves to the next route only on a rejection. `readSubscriptionRateLimit` reports a rejection as a 429 for the 5-hour window or a weekly window. Failover happens before any byte reaches the client. The handler holds the rejection of the project's own account. When the last route also rejects, it forwards that held rejection. Without a held rejection, it forwards the response of the last route. The database records every attempt.
5. For a route with a live grant, `buildUpstreamHeaders` replaces the `authorization` header with the access token of the grant and changes nothing else. A route without a live grant keeps Claude Code's token. `forwardUpstreamResponse` streams the response to the client. `AnthropicMessageStreamAssembler` rebuilds the full message from the SSE events for the database.

`~/.claude-proxy/subscription_accounts.yml` lists the accounts, the project routes and the default account. Each account can have its own `failover_utilization` (default 1, which means no threshold). A top-level `failover_utilization` is a validation error. `YamlConfigFile` reads it again at each change. After a parse or validation error, or when the file disappears, it keeps the last valid configuration and reports the error to the web UI. A file that is broken at start gives an empty configuration, so there is no routing.

`SubscriptionAccountLoginHandler` logs in an account from the web UI with OAuth PKCE and the redirect URI `http://localhost:<proxy port>/callback`. `SubscriptionAccountStore` keeps the grants, the usage windows and the limit blocks in `requests.sqlite`. The proxy never reads, copies or refreshes Claude Code's own grant. `SubscriptionAccountUsageMonitor` polls `/api/oauth/usage` with each live grant every 5 minutes. A response to a route with a live grant updates the usage of its account from its headers. A response sent with Claude Code's own token updates nothing.

## Facts checked against real Claude Code traffic

- Claude Code 2.1.304 honours `HTTPS_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS`. With `ANTHROPIC_BASE_URL` set to the proxy, `claude remote-control` fails with "Remote Control is only available when using Claude via api.anthropic.com".
- Remote Control uses plain HTTPS to `api.anthropic.com` (`/v1/environments/*`, `/v1/code/sessions/*`), with no WebSocket upgrade.
- On `api.anthropic.com`, Claude Code also calls paths outside `/v1/` and `/api/`, such as `/mcp-registry/v0/servers`.

- A `/v1/messages` request whose `metadata.user_id` names a different `account_uuid` than the account of the token is accepted (tested 2026-10-26). The usage counts against the account of the token.
- Refreshing an OAuth grant revokes the previous access token of that grant at once (claude-swap issue #381). The proxy therefore never refreshes Claude Code's grant.
- `anthropic-ratelimit-unified-7d-utilization` is a fraction from 0 to 1, with two decimals. A value of 1.00 can still leave room before the subscription rejects requests. `anthropic-ratelimit-unified-7d-reset` is in epoch seconds.
- `/api/oauth/usage` returns `seven_day.utilization` as a percentage and `seven_day.resets_at` as ISO 8601. The endpoint is undocumented.
- Claude Code sends the session ID in the `x-claude-code-session-id` header. It also sends the ID in `metadata.user_id`, which is a JSON string.
- The `Primary working directory:` line is in a mid-conversation `role: "system"` message, not in top-level `system`. `extractProjectPath` therefore searches `system` and then each message in order.
- When the shell changes directory, Claude Code adds a `# Environment update` section with `Primary working directory: <new> (was <old>)`. `extractProjectPath` ignores that section, so the project is the directory that Claude Code started in.
- After the first request of a conversation, Claude Code 2.1.304 sends only the new messages, without the environment block. The billing header in `system` has `cc_prev_req=<request-id of the previous response>`. `RequestDatabase` gives such a request the project of that previous request, or else of the latest earlier request in the session, and sets `is_project_path_inherited`.

## Full-text search

Each request repeats the whole conversation, so `proxied_request_search` (FTS5, rowid = `proxied_requests.id`) indexes only what is new in each request:

- `user_text`: the last user message, without `<system-reminder>` blocks;
- `tool_text`: the tool results in that message, plus the tool calls and thinking of the response;
- `response_text`: the text of the response.

Do not index the full request body.

## Web UI and menu bar

- The web UI is served from `dist` under `/_proxy/`. `vite.config.ts` removes the Origin in the dev proxy only when it is the dev server's own.
- The menu bar app has port 4100 fixed in `ClaudeProxyMenuBar.swift`. It reads `GET /_proxy/api/subscription-account-status` once a minute, and every 5 seconds while the proxy does not answer. It draws one weekly usage pie per account, and the pie turns red when the account is blocked or at its `failover_utilization`.
- `launchd/install_launchd_agents.sh` stores the absolute `node` path in the agent plist. Run the script again after a Node.js upgrade.
