# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

claude-proxy is a local proxy for Claude Code on `127.0.0.1:4100`. It records every request in SQLite. In auto mode it sends subscription traffic to API keys when weekly subscription usage reaches 98%. `README.md` describes the behaviour for users.

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

`claude_proxy_server.ts` checks every request with `isLocalRequest`. The Host must be `127.0.0.1` or `localhost` on the proxy port, and the Origin must be absent or the proxy's own. It then sends the request to one of three handlers:

- `/_proxy/api/*` goes to `web_api_handler.ts`.
- `/_proxy/*` goes to `web_ui_static_file_handler.ts`.
- `/v1/*` and `/api/*`, the only paths that Claude Code uses, go to `proxy_request_handler.ts`.
- Every other path gets a local 404 and is not recorded.

`handleProxyRequest` does the following:

1. It classifies the client auth. `Authorization: Bearer` is a subscription OAuth token, and `x-api-key` is passthrough.
2. Only OAuth requests to `/v1/messages*` follow `RoutingState.planUpstreamRoutes()`. All other requests go to `api.anthropic.com` unchanged.
3. It tries the planned routes in order, and moves to the next route in two cases only:
   - `readSubscriptionWeeklyRateLimit` reports a 429 for a `seven_day*` window;
   - an API key returns 401.

   Failover happens before any byte reaches the client. The response of the last route is always forwarded.
4. For an API key route, `buildUpstreamHeaders` removes `authorization` and the `oauth-*` beta flags, and sets `x-api-key`.
5. `forwardUpstreamResponse` streams the response to the client. `AnthropicMessageStreamAssembler` rebuilds the full message from the SSE events for the database.

`RoutingState` keeps the mode, the selected key and the weekly usage in the `proxy_settings` table. Every subscription response updates the weekly usage from its headers. `SubscriptionUsageMonitor` polls `/api/oauth/usage` every 5 minutes, but only while the limit is reached. It uses the last OAuth token that passed through the proxy.

## Facts checked against real Claude Code traffic

- `anthropic-ratelimit-unified-7d-utilization` is a fraction from 0 to 1. `anthropic-ratelimit-unified-7d-reset` is in epoch seconds.
- `/api/oauth/usage` returns `seven_day.utilization` as a percentage and `seven_day.resets_at` as ISO 8601. The endpoint is undocumented.
- Claude Code sends the session ID in the `x-claude-code-session-id` header. It also sends the ID in `metadata.user_id`, which is a JSON string.
- The `Primary working directory:` line is in a mid-conversation `role: "system"` message, not in top-level `system`. `extractProjectPath` therefore searches `system` and then each message in order.

## Full-text search

Each request repeats the whole conversation, so `proxied_request_search` (FTS5, rowid = `proxied_requests.id`) indexes only what is new in each request:

- `user_text`: the last user message, without `<system-reminder>` blocks;
- `tool_text`: the tool results in that message, plus the tool calls and thinking of the response;
- `response_text`: the text of the response.

Do not index the full request body.

## Web UI and menu bar

- The web UI is served from `dist` under `/_proxy/`. `vite.config.ts` removes the Origin in the dev proxy only when it is the dev server's own.
- The menu bar app has port 4100 fixed in `ClaudeProxyMenuBar.swift`. It reads `GET /_proxy/api/routing-status` once a minute, and every 5 seconds while the proxy does not answer.
- `launchd/install_launchd_agents.sh` stores the absolute `node` path in the agent plist. Run the script again after a Node.js upgrade.
