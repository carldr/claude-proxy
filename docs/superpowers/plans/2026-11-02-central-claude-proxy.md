# Central claude-proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one claude-proxy at `https://claude-proxy.example.com` behind Gateway Auth, and send the Claude Code traffic of every machine of the user to it through a local relay.

**Architecture:** The relay listens on `127.0.0.1:4100` on each machine and is Claude Code's `HTTPS_PROXY`. For `CONNECT api.anthropic.com:443` it opens an HTTP upgrade (`Upgrade: claude-proxy-tunnel`) to the central service, with `X-Gateway-Auth-Token`, and falls back to a direct TCP tunnel when the upgrade fails. The central server decrypts the tunnel with its own CA and handles it as it handles a `CONNECT` today. Gateway Auth's `/verify` accepts the token, found by its SHA-256 in a team pref.

**Tech Stack:** Node.js 26 with TypeScript type stripping, `node:test`, `node:sqlite`, openssl, Docker Compose, Caddy (Moss), Appwrite function (Gateway Auth), Appwrite CLI.

**Spec:** `docs/superpowers/specs/2026-11-02-central-claude-proxy-design.md`

## Global Constraints

- Two repositories: claude-proxy (`~/Development/claude-proxy`, tasks 1–9 and 11) and gateway-auth-repository (`~/Development/gateway-auth-repository`, task 10). Task 12 is the deployment.
- The server code follows claude-proxy's `CLAUDE.md`: TypeScript type stripping, `erasableSyntaxOnly`, `.ts` imports, `import type`, no new npm packages.
- Names say the whole thing they are (user rule): `gatewayAuthToken`, not `token`.
- Comments and docs use ASD-STE100. Each task updates `README.md` and `CLAUDE.md` where its behaviour shows.
- Central URL: `https://claude-proxy.example.com`. Tunnel path: `/_proxy/tunnel`. Upgrade token: `claude-proxy-tunnel`. Header: `X-Gateway-Auth-Token`.
- The relay listens on `127.0.0.1:4100`. Its directory is `~/.claude-proxy-relay/`, with `central_url`, `gateway_auth_token` (both mode 600) and `certificate_authority.pem`.
- The central service tunnels only to `api.anthropic.com:443`. With a public hostname set, the server refuses every `CONNECT`.
- The CA permits only the name `api.anthropic.com`. Its key never leaves the central volume.
- Gateway Auth team: `gateway-auth-claude-proxy`. Commands and scripts take the team name and find its ID.
- Team pref `gateway_auth_tokens` is a JSON string of `[{ "name", "sha256", "created_at" }]`, beside `allowed_domains`. `updatePrefs` replaces the whole object.
- docker-host: compose project `/root/claude-proxy`, image `registry.example.com:5000/claude-proxy:<commit>`, volume `claude-proxy-data`, `restart: always`, host port 4100.
- Never run two servers that hold the same grants. After the cut-over, the first Mac server agent never starts again.
- Commit each task when its tests pass, staging files by name.

## Review Focus

1. Gateway Auth in front of the upgrade: Caddy's `forward_auth` sends a copy of the upgrade request's headers to `/verify`. A valid token must still give `101` end to end. Task 12, step 6 checks it.
2. A central service that accepts TCP and never answers: the relay must fall back to a direct tunnel within 5 seconds, not hang Claude Code. Task 8 test `falls back to a direct tunnel when the central service does not answer within 5 seconds`.
3. A pasted login code with spaces or a newline: the server trims it, and names the problem when the `#<state>` part is missing. Task 3 tests.
4. A relay that starts while the central service is down: it still listens and tunnels directly, and keeps any `certificate_authority.pem` it has. Task 8 test `starts and tunnels directly when the central service is down at start`.
5. Many Claude Code sessions at once: ten tunnels at the same time through one relay all carry their own bytes. Task 8 test `carries ten tunnels at once`.

---

### Task 1: Accept the public hostname, and refuse CONNECT on a public install

**Files:**
- Modify: `packages/claude_proxy_server/src/claude_proxy_server.ts` (`isLocalRequest`, options, `connect` handler)
- Modify: `packages/claude_proxy_server/src/main.ts`
- Test: `packages/claude_proxy_server/test/claude_proxy_server.test.ts`

**Interfaces:**
- Produces: `ClaudeProxyServerOptions.publicHostname: string | null`. `isAcceptedRequest(clientRequest, httpServer, publicHostname): boolean`, which replaces `isLocalRequest`. Environment variables `CLAUDE_PROXY_LISTEN_ADDRESS` (default `127.0.0.1`) and `CLAUDE_PROXY_PUBLIC_HOSTNAME` (default unset).

- [ ] **Step 1: Write the failing tests** in the `claude-proxy` describe, with a second server made with `publicHostname: 'claude-proxy.example.test'`:
  - `accepts a request addressed to the public hostname, with no Origin or its https Origin`: `Host: claude-proxy.example.test` to `/_proxy/api/subscription-account-status` gives 200, and the same with `Origin: https://claude-proxy.example.test` gives 200.
  - `refuses a request to the public hostname from another Origin`: `Origin: https://evil.example.test` gives 403.
  - `refuses every CONNECT when a public hostname is set`: `CONNECT api.anthropic.com:443` gives `405`, and `CONNECT example.com:443` gives `405`.
  - The existing test `rejects requests from web pages and requests addressed to another host name` still passes on the server without a public hostname.
- [ ] **Step 2: Run** `node --test --test-name-pattern="public hostname" packages/claude_proxy_server/test/claude_proxy_server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `main.ts` listens on `CLAUDE_PROXY_LISTEN_ADDRESS` and passes `publicHostname`. With a public hostname, the `connect` handler answers `HTTP/1.1 405 Method Not Allowed` and closes. The 403 text names both the loopback names and the public hostname.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Update** README "Security" and `CLAUDE.md` "Request flow" with the public hostname, then commit.

### Task 2: The tunnel endpoint

**Files:**
- Modify: `packages/claude_proxy_server/src/https_proxy_connect_handler.ts`
- Modify: `packages/claude_proxy_server/src/claude_proxy_server.ts` (`upgrade` handler)
- Test: `packages/claude_proxy_server/test/claude_proxy_server.test.ts`

**Interfaces:**
- Consumes: `publicHostname` and `isAcceptedRequest` from Task 1.
- Produces: `decryptAnthropicApiConnection(clientSocket: Duplex, acceptedResponseHead: string, options: HttpsProxyConnectHandlerOptions): void`, which both the `CONNECT` path (`HTTP/1.1 200 Connection Established\r\n\r\n`) and the tunnel path (`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: claude-proxy-tunnel\r\n\r\n`) call. Constant `claudeProxyTunnelPath = '/_proxy/tunnel'` and `claudeProxyTunnelUpgradeToken = 'claude-proxy-tunnel'`, exported from `https_proxy_connect_handler.ts`.

- [ ] **Step 1: Write the failing tests** in a new describe `as a tunnel endpoint`. Use the certificate setup of `as an HTTPS_PROXY`:
  - `decrypts an upgraded tunnel and records the request`: send `GET /_proxy/tunnel` with `Connection: Upgrade`, `Upgrade: claude-proxy-tunnel`, `Host: claude-proxy.example.test`. Expect `101`. Then open TLS over the socket with `servername: 'api.anthropic.com'` and the test CA, send `POST /v1/messages`, and expect the fake upstream's answer and one recorded request.
  - `refuses an upgrade to another protocol or path`: `Upgrade: websocket` on `/_proxy/tunnel` gives `400`. `Upgrade: claude-proxy-tunnel` on `/_proxy/other` gives `404`.
  - `refuses an upgrade addressed to another host name`: `Host: other.example.test` gives `403`.
- [ ] **Step 2: Run** `node --test --test-name-pattern="tunnel endpoint" …`. Expected: FAIL.
- [ ] **Step 3: Implement** the `upgrade` handler on `httpServer`. It checks the host, the path and the upgrade token, in that order, then calls `decryptAnthropicApiConnection`. It tracks the socket with the `CONNECT` sockets, so `close()` destroys it.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Update** `CLAUDE.md` "Request flow" with the tunnel path, then commit.

### Task 3: Log in through the manual code page

**Files:**
- Modify: `packages/claude_proxy_server/src/subscription_account_login_handler.ts`
- Modify: `packages/claude_proxy_server/src/web_api_handler.ts`
- Modify: `packages/claude_proxy_server/src/claude_proxy_server.ts` (remove the `/callback` route)
- Modify: `packages/claude_proxy_web_ui/src/SubscriptionAccountsPanel.tsx`, `packages/claude_proxy_web_ui/src/claude_proxy_api.ts`
- Test: `packages/claude_proxy_server/test/claude_proxy_server.test.ts` (describe `subscription account login`)

Ruling: every install uses the manual redirect URI, so there is one login flow. The loopback callback goes.

**Interfaces:**
- Produces: `subscriptionAccountManualRedirectUri = 'https://platform.claude.com/oauth/code/callback'`. `SubscriptionAccountLoginHandler.finishLogin(pastedAuthorizationCode: string): Promise<void>`, public. API `POST /_proxy/api/subscription-account-logins/finish` with JSON `{ "pastedAuthorizationCode": "<code>#<state>" }`: 204 on success, 400 with `{ error }` otherwise. Web UI function `claudeProxyApi.finishSubscriptionAccountLogin(pastedAuthorizationCode: string)`.

- [ ] **Step 1: Change and add tests** in `subscription account login`:
  - The authorize URL has `redirect_uri=https://platform.claude.com/oauth/code/callback`, and the token request sends that `redirect_uri`.
  - `finishes a login with the pasted code and state`: posting `"<code>#<state>"` stores the grant.
  - `trims spaces and newlines around the pasted code`: `"  <code>#<state>\n"` stores the grant.
  - `names the missing state`: posting `"<code>"` gives 400 with an error that contains `#`.
  - The tests of the old `/callback` route go, except their checks of an unknown state, an expired state and a removed account, which move to the new endpoint.
- [ ] **Step 2: Run** `node --test --test-name-pattern="login" …`. Expected: FAIL.
- [ ] **Step 3: Implement.** `finishLogin` splits the trimmed text at the last `#`, then runs the checks that the callback ran. The panel shows a text field and **Finish login** under an account after **Log in** opens the authorize URL.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Update** README "Log in to the subscription accounts" (the browser shows a code; paste it into the field), then commit.

### Task 4: Absolute project route patterns

**Files:**
- Modify: `packages/claude_proxy_server/src/subscription_accounts_config.ts`, its callers, `packages/claude_proxy_server/default_config/subscription_accounts.yml` if it uses `~`
- Test: `packages/claude_proxy_server/test/subscription_accounts_config.test.ts`

**Interfaces:**
- Produces: `parseSubscriptionAccountsConfig(yamlValue: unknown): SubscriptionAccountsConfig`, with no `homeDirectory` parameter.

- [ ] **Step 1: Change the tests:** a pattern `/Users/test/Development/client*` matches `/Users/test/Development/client-a/x`. A pattern that starts with `~` is a validation error whose message contains `absolute path`. A relative pattern such as `Development/x` is the same error.
- [ ] **Step 2: Run** `node --test packages/claude_proxy_server/test/subscription_accounts_config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the validation and remove the expansion.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Update** README "Configuration" (the example and the `project_routes` row), then commit.

### Task 5: Remove the session log file path

**Files:**
- Modify: `packages/claude_proxy_server/src/web_api_handler.ts` (remove `findClaudeCodeSessionLogFiles`, `defaultClaudeCodeProjectsDirectory`, `claudeCodeProjectsDirectory`), `claude_proxy_server.ts`, `main.ts`
- Modify: `packages/claude_proxy_web_ui/src/SessionsView.tsx`, `claude_proxy_api.ts`
- Test: `packages/claude_proxy_server/test/claude_proxy_server.test.ts`

- [ ] **Step 1: Change the test** of `/_proxy/api/sessions` so that it expects no `session_log_file_path` field, and delete its test fixture of `~/.claude/projects`.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement.** The Resume cell keeps the `claude --resume` command and the Copy button, with no title.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Update** README "Web UI", then commit.

### Task 6: The certificate authority script

**Files:**
- Create: `scripts/create_certificate_authority.sh`
- Modify: `packages/claude_proxy_server/src/https_proxy_connect_handler.ts` (the 502 text names the script)
- Modify: `packages/claude_proxy_server/src/web_ui_static_file_handler.ts` or `web_api_handler.ts`
- Test: `packages/claude_proxy_server/test/certificate_authority.test.ts`

**Interfaces:**
- Produces: `sh scripts/create_certificate_authority.sh <directory>` writes `certificate_authority.pem`, `certificate_authority-key.pem`, `api.anthropic.com.pem` and `api.anthropic.com-key.pem`, keys mode 600. It refuses to overwrite an existing CA. `GET /_proxy/certificate_authority.pem` serves `<claudeProxyDirectory>/certificate_authority.pem`, or 404 when it is missing.

- [ ] **Step 1: Write the failing tests:**
  - `makes a CA whose certificate for api.anthropic.com a TLS client trusts`: run the script into a temporary directory. A `tls` server with the leaf and a client with `ca: certificate_authority.pem` and `servername: 'api.anthropic.com'` connect without an error.
  - `makes a CA that cannot sign another name`: sign a certificate for `example.com` with the CA key, using openssl. A client for `example.com` with that CA fails with an error whose code contains `NAME_CONSTRAINT` or whose message contains `permitted`.
  - `refuses to replace an existing CA`: a second run exits non-zero and leaves the files unchanged.
  - `serves the CA certificate`: `GET /_proxy/certificate_authority.pem` returns the file's bytes.
- [ ] **Step 2: Run** `node --test packages/claude_proxy_server/test/certificate_authority.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with openssl: an EC P-256 CA, `basicConstraints=critical,CA:true,pathlen:0`, `keyUsage=critical,keyCertSign,cRLSign`, `nameConstraints=critical,permitted;DNS:api.anthropic.com`, 10 years. The leaf has `subjectAltName=DNS:api.anthropic.com`, `extendedKeyUsage=serverAuth`, 10 years.
- [ ] **Step 4: Run** `pnpm test`. Expected: all pass.
- [ ] **Step 5: Update** README "Install" (the script replaces mkcert) and "Security" (the CA signs only `api.anthropic.com`), then commit.

### Task 7: The container image and the compose file

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `deploy/docker-compose.yml`, `deploy/README.md`

**Interfaces:**
- Produces: image with `CLAUDE_PROXY_DIRECTORY=/data`, `CLAUDE_PROXY_LISTEN_ADDRESS=0.0.0.0`, `CLAUDE_PROXY_PORT=4100`, `USER node`, `CMD ["node", "packages/claude_proxy_server/src/main.ts"]`. The compose service `claude_proxy` sets `CLAUDE_PROXY_PUBLIC_HOSTNAME=claude-proxy.example.com` and `CLAUDE_PROXY_GATEWAY_AUTH_VERIFY_URL` (Task 13; the value goes in `.env` beside the compose file), mounts `claude-proxy-data:/data`, publishes `4100:4100`, `restart: always`, and has a healthcheck on `http://127.0.0.1:4100/_proxy/api/subscription-account-status`, a loopback request from inside the container.

- [ ] **Step 1: Write the files.** The build stage is `node:26-slim` with corepack's pnpm. It installs with `--frozen-lockfile` and runs `pnpm --filter claude_proxy_web_ui build`, not `pnpm build`, which also builds the macOS menu bar. The run stage installs `openssl` with `apt-get install -y --no-install-recommends`, and copies `packages/`, `scripts/` and `node_modules`. `deploy/README.md` gives the build and push commands in the other_app layout:

  ```sh
  docker --host ssh://docker-builder build -t localhost:5000/claude-proxy:<commit> https://github.com/carldr/claude-proxy.git#<commit>
  docker --host ssh://docker-builder push localhost:5000/claude-proxy:<commit>
  ```

- [ ] **Step 2: Verify** with the image built on docker-builder: `docker --host ssh://docker-builder run --rm -e CLAUDE_PROXY_PUBLIC_HOSTNAME=claude-proxy.example.com -p 4199:4100 <image>` starts, and the log has `claude-proxy listens on`. Stop it. No grant is in the empty `/data`, so nothing refreshes.
- [ ] **Step 3: Update** README with a "Run as a central service" section that points to `deploy/README.md`, then commit.

### Task 8: The relay

**Files:**
- Create: `packages/claude_proxy_relay/package.json`, `tsconfig.json`, `src/claude_proxy_relay.ts`, `src/main.ts`, `test/claude_proxy_relay.test.ts`
- Modify: root `package.json` (`test` runs `'packages/*/test/*.test.ts'`; `start:relay`)

**Interfaces:**
- Produces: `createClaudeProxyRelay(options: ClaudeProxyRelayOptions): { httpServer: http.Server; close(): Promise<void> }` with `ClaudeProxyRelayOptions = { centralUrl: URL; gatewayAuthToken: string; relayDirectory: string; anthropicApiHost: string; anthropicApiPort: number; tunnelUpgradeTimeoutMilliseconds: number }`. `main.ts` reads `central_url` and `gateway_auth_token` from `CLAUDE_PROXY_RELAY_DIRECTORY` (default `~/.claude-proxy-relay`), listens on `127.0.0.1:${CLAUDE_PROXY_RELAY_PORT ?? 4100}`, uses `api.anthropic.com:443` and a 5000 ms timeout, and refuses to start when either file is missing or readable by others.

- [ ] **Step 1: Write the failing tests,** each with fake servers on loopback ports. The fake central is an `http.Server` (the relay accepts `http:` and `https:` central URLs).
  - `sends an api.anthropic.com CONNECT through the central tunnel with the token`: the fake central answers `101` and echoes. Expect `200 Connection Established`, the echoed bytes, and `x-gateway-auth-token` and `upgrade: claude-proxy-tunnel` on the fake central's request.
  - `falls back to a direct tunnel when the central service answers without 101`: the fake central answers `302`. Expect `200` and bytes from the fake Anthropic server.
  - `falls back to a direct tunnel when the central service does not answer within 5 seconds`: the fake central accepts TCP and writes nothing. With `tunnelUpgradeTimeoutMilliseconds: 200`, expect the direct tunnel within 1 second.
  - `tunnels another host from this machine`: `CONNECT 127.0.0.1:<port>` reaches that port, and the fake central gets no request.
  - `carries ten tunnels at once`: ten CONNECTs at the same time, each echoing its own text, each get their own text back.
  - `forwards the subscription account status with the token`: `GET /_proxy/api/subscription-account-status` returns the fake central's body, and the fake central got the token. With the central down, the relay answers 502.
  - `downloads the CA certificate at start`: the fake central serves `/_proxy/certificate_authority.pem`, and `<relayDirectory>/certificate_authority.pem` then holds it.
  - `starts and tunnels directly when the central service is down at start`: the central URL points at a closed port. The relay listens, keeps an existing `certificate_authority.pem` unchanged, and a CONNECT reaches the fake Anthropic server.
- [ ] **Step 2: Run** `node --test packages/claude_proxy_relay/test/claude_proxy_relay.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The upgrade uses `http.request` or `https.request` with `agent: false` and listens for `upgrade`. A `response` event, an `error` or the timeout falls back. The relay logs one line per fallback with the reason, at most once a minute.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Update** README "How it works" and a new "Relay" section, and `CLAUDE.md` with the relay's flow, then commit.

### Task 9: Start the relay at login

**Files:**
- Modify: `launchd/install_launchd_agents.sh`, `launchd/uninstall_launchd_agents.sh`
- Create: `systemd/claude-proxy-relay.service`

**Interfaces:**
- Consumes: `packages/claude_proxy_relay/src/main.ts` from Task 8.
- Produces: launchd agent `local.claude-proxy.relay` in place of `local.claude-proxy.server`. The install script boots out `local.claude-proxy.server` and deletes its plist. The systemd user unit runs `node <repository>/packages/claude_proxy_relay/src/main.ts` with `Restart=always`, for the Roy dotfiles to install.

- [ ] **Step 1: Change the scripts and add the unit.**
- [ ] **Step 2: Verify** on the first Mac only in Task 12. Here, run `sh -n` on both scripts and `systemd-analyze verify` on the unit on roy-host (`scp` it to `/tmp` first). Expected: no errors.
- [ ] **Step 3: Update** README "Install" and "Connecting Claude Code": the zsh function checks the relay on `127.0.0.1:4100` and sets `NODE_EXTRA_CA_CERTS="$HOME/.claude-proxy-relay/certificate_authority.pem"`. Commit.

### Task 10: Gateway Auth tokens (gateway-auth-repository)

**Files:**
- Create: `functions/gateway-auth/src/gateway_auth_tokens.js`, `functions/gateway-auth/tests/gateway_auth_tokens.test.js`, `functions/gateway-auth/scripts/gateway_auth_tokens.js`
- Modify: `functions/gateway-auth/src/main.js` (`/verify`), `functions/gateway-auth/README.md`, `functions/gateway-auth/package.json` (`tokens` script)

**Interfaces:**
- Produces: `findGatewayAuthTokenName(gatewayAuthToken: string, teamPrefs: Record<string, unknown>): string | null` and `hashGatewayAuthToken(gatewayAuthToken: string): string` (SHA-256, hex). Script: `pnpm --filter gateway-auth tokens add|list|remove <team-name> [<token-name>]`.

- [ ] **Step 1: Write the failing tests** of `findGatewayAuthTokenName`: a known token gives its name; an unknown token gives null; missing or broken `gateway_auth_tokens` gives null; an empty token gives null. The comparison uses `crypto.timingSafeEqual`.
- [ ] **Step 2: Run** `pnpm --filter gateway-auth test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `/verify`, a request with `x-gateway-auth-token` reads the team with `serverTeams.get(teamId)`. A match answers 200 `{ name }`, and no match answers 401. A request without the header runs the cookie check unchanged.
  - The script runs the `appwrite` CLI with a temporary `appwrite.config.json` for project `<project ID>` at `https://appwrite.example.com/v1`. It finds the team ID by its exact name, reads the prefs, changes `gateway_auth_tokens`, and writes all the prefs back. `add` prints the new token once (32 random bytes, base64url) and refuses a name that exists.
- [ ] **Step 4: Run** `pnpm --filter gateway-auth test`, `lint` and `typecheck`. Expected: all pass.
- [ ] **Step 5: Update** `functions/gateway-auth/README.md` with the header and the script, then commit. A push to `master` deploys the function (`functions/README.md`), so the push happens in Task 12.

### Task 11: Documentation pass

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Check** that README covers the central service end to end: the relay, the CA, Gateway Auth, the manual login, the absolute routes and the cut-over. Check that `CLAUDE.md` covers the tunnel path and the relay. Fix any gap.
- [ ] **Step 2: Commit.**

### Task 13: Verify every public request with Gateway Auth

Runs after Task 5 and before Task 6. Task 7's compose file and Task 12 use its setting.

**Files:**
- Create: `packages/claude_proxy_server/src/gateway_auth_verifier.ts`
- Modify: `packages/claude_proxy_server/src/claude_proxy_server.ts` (request dispatch, `upgrade` handler, `isAcceptedRequest`), `packages/claude_proxy_server/src/main.ts`
- Test: `packages/claude_proxy_server/test/gateway_auth_verifier.test.ts`, `packages/claude_proxy_server/test/claude_proxy_server.test.ts`

**Interfaces:**
- Consumes: `publicHostname`, `isAcceptedRequest` (Task 1); the tunnel `upgrade` handler (Task 2).
- Produces: `class GatewayAuthVerifier` with `constructor(gatewayAuthVerifyUrl: URL, options: { cacheMilliseconds: number; timeoutMilliseconds: number })` and `isVerified(requestHeaders: IncomingHttpHeaders): Promise<boolean>`. `ClaudeProxyServerOptions.gatewayAuthVerifyUrl: URL | null`. Environment variable `CLAUDE_PROXY_GATEWAY_AUTH_VERIFY_URL`. Values: cache 60 000 ms, timeout 5000 ms.

- [ ] **Step 1: Write the failing tests** of `GatewayAuthVerifier`, against a fake verify server on loopback:
  - `sends the token and the cookie to the verify URL, and passes on a 200`: the fake server receives `x-gateway-auth-token` and `cookie` unchanged, and no other request header but `host`.
  - `refuses on a 401, on a 302 and on no answer within the timeout`: each gives `false`; the no-answer case with `timeoutMilliseconds: 200` returns within 1 second.
  - `refuses a request without a token or a gate_session cookie, without calling the verify URL`.
  - `keeps a pass for the cache time, keyed by the token or the gate_session cookie`: two calls with the same token within the cache time make one verify request; after the cache time (`mock.timers` on `Date`), a third call makes a second request. A different token makes its own request. A refusal is not kept.
- [ ] **Step 2: Write the failing server tests** with a server made with `publicHostname: 'claude-proxy.example.test'` and `gatewayAuthVerifyUrl` pointing at a fake verify server:
  - `serves a public request that Gateway Auth verifies`, and `answers 401 to a public request that Gateway Auth refuses` (web API path).
  - `answers 401 to a tunnel upgrade that Gateway Auth refuses`, and the upgrade with a verified token still gives `101`.
  - `accepts a loopback Host only from a loopback connection`: `isAcceptedRequest` with a request whose `socket.remoteAddress` is `172.17.0.5` and `Host: 127.0.0.1:<port>` returns false.
  - `refuses to start with a public hostname and no Gateway Auth verify URL`: `createClaudeProxyServer` throws, and the message names `CLAUDE_PROXY_GATEWAY_AUTH_VERIFY_URL`.
  - A server without a public hostname makes no verify request (the existing tests pass unchanged).
- [ ] **Step 3: Run** `node --test packages/claude_proxy_server/test/gateway_auth_verifier.test.ts` and the new server tests. Expected: FAIL.
- [ ] **Step 4: Implement.** The check runs after `isAcceptedRequest` and only for the public Host. The verifier keys its cache by `sha256(token)` when the token is present, else by `sha256(gate_session)`. It never logs a token or a cookie.
- [ ] **Step 5: Run** `pnpm test` and `pnpm typecheck`. Expected: all pass.
- [ ] **Step 6: Update** README "Security" and `CLAUDE.md` "Request flow" (a public request needs Gateway Auth's 200, asked by claude-proxy), then commit.

### Task 14: The relay's proxy credential

Runs after Task 10 and before Task 9. Task 9's agents, the zsh function and Task 12 use the credential.

**Files:**
- Modify: `packages/claude_proxy_relay/src/claude_proxy_relay.ts`, `packages/claude_proxy_relay/src/main.ts`
- Modify: `macos/claude_proxy_menu_bar/ClaudeProxyMenuBar.swift`
- Modify: `README.md` (zsh function, `env` in `settings.json`, the relay section), `CLAUDE.md`
- Test: `packages/claude_proxy_relay/test/claude_proxy_relay.test.ts`

**Interfaces:**
- Produces: file `<relayDirectory>/proxy_credential`, mode 600, 32 random bytes as base64url, written once with an exclusive create. User name `relay`. `ClaudeProxyRelayOptions.relayProxyCredential: string`. CONNECT needs `Proxy-Authorization: Basic base64("relay:<credential>")`; `GET /_proxy/api/subscription-account-status` needs `Authorization: Basic` of the same pair. A missing or wrong CONNECT credential gets `407 Proxy Authentication Required` with `Proxy-Authenticate: Basic realm="claude-proxy-relay"`; a missing or wrong status credential gets `401`. Comparison with `crypto.timingSafeEqual` on equal-length buffers.

- [ ] **Step 1: Write the failing tests:**
  - `refuses a CONNECT without the proxy credential`: no header, a wrong credential, and a wrong user name each get 407 with the `Proxy-Authenticate` header, and no tunnel opens.
  - `accepts a CONNECT with the proxy credential`: the existing CONNECT tests send the header and pass.
  - `refuses the status request without the credential`: 401; with `Authorization: Basic` it is forwarded as before.
  - `writes the proxy credential once at first start, mode 600`: a second start keeps the same value; a credential file readable by group or others makes `main.ts` refuse to start, naming the file.
- [ ] **Step 2: Run** `node --test packages/claude_proxy_relay/test/claude_proxy_relay.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in the relay, then the menu bar: it reads `~/.claude-proxy-relay/proxy_credential` at each poll and sends `Authorization: Basic`. A missing file shows the same grey `!` as a relay that does not answer.
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck` and `pnpm build` (the menu bar build). Expected: all pass.
- [ ] **Step 5: Update** README: the zsh function reads the credential file, builds `HTTPS_PROXY=http://relay:<credential>@127.0.0.1:4100`, and checks the relay with `curl -u relay:<credential>`; the `settings.json` method gives the same URL; a host with several users sets `CLAUDE_PROXY_RELAY_PORT` per user. Commit.

### Task 12: Deployment and cut-over

Each step is a command with a check. Stop and report on any failed check.

- [ ] **Step 1:** Push claude-proxy and gateway-auth-repository. Check that the Gateway Auth deployment of the push finished, in the Appwrite console or with `appwrite functions list-deployments`.
- [ ] **Step 2:** Build and push the image (`deploy/README.md`). Check: `docker --host ssh://docker-builder images` lists the tag.
- [ ] **Step 3:** On docker-host:
  - Copy `deploy/docker-compose.yml` to `/root/claude-proxy/`.
  - Run `docker compose up -d` once with an empty volume.
  - Run the CA script in the container: `docker compose exec claude_proxy sh scripts/create_certificate_authority.sh /data`.
  - Check: the healthcheck is `healthy`. The container runs until Step 7 stops it.
- [ ] **Step 4:** Add the proxy. Check that DNS resolves and that `https://claude-proxy.example.com/_proxy/` redirects to the Gateway Auth login:
  ```sh
  moss --cluster production proxy add --domain claude-proxy.example.com --vm-name docker-host --target-port 4100 --proxy-mode none --create-dns-cname-record --gateway-auth-team-id <id of gateway-auth-claude-proxy> --yes
  ```
- [ ] **Step 5:** Make the tokens `first-mac`, `second-mac` and `roy-host` with the Task 10 script. Write each into the `gateway_auth_token` of its machine, mode 600.
- [ ] **Step 6:** Check Review Focus 1. With the first Mac token, the Task 8 relay test client against `https://claude-proxy.example.com` gets `101`. A wrong token gets no `101`.
- [ ] **Step 7:** Cut-over, design section "Cut-over" steps 1–7. The container stays stopped from the first copy until the first Mac server agent is stopped.
  1. Run `docker compose stop` in `/root/claude-proxy`. Check with `docker compose ps` that it is stopped.
  2. Delete `requests.sqlite-wal` and `requests.sqlite-shm` from the volume's directory, or stop and report if they exist after Sub-step 1. Then rsync `requests.sqlite`, `subscription_accounts.yml` and `pricing.yml` to the volume's directory, `docker volume inspect claude-proxy-data --format '{{.Mountpoint}}'`, while the first Mac proxy runs.
  3. Quit every Claude Code session on the first Mac. A running session keeps `HTTPS_PROXY=http://127.0.0.1:4100` with no credential, so it gets connection refused after the stop and 407 after the relay starts.
  4. Run `launchctl bootout gui/$(id -u)/local.claude-proxy.server`.
  5. rsync again, then `chown 1000:1000` and `chmod 600` the copied files. The server refuses files that another user owns, and the container runs as `node` (UID 1000).
  6. Change the routes to absolute paths in the copy of `subscription_accounts.yml` on the volume.
  7. Run `docker compose start`.
- [ ] **Step 8:** Install the relay agent on the first Mac (`pnpm install_launchd_agents`). A session that starts after the install uses the relay. Check that one new Claude Code request shows in the web UI with its project, and that the menu bar shows the pies.
- [ ] **Step 9:** Install the relay on the second Mac (Task 9 launchd) and on roy-host (the systemd unit, through the Roy dotfiles). Check one request from each in the web UI.
- [ ] **Step 10:** Delete `~/.claude-proxy/api.anthropic.com*.pem` on the first Mac.
