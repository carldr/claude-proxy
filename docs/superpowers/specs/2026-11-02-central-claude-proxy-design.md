# Central claude-proxy: design

## Intent

claude-proxy runs on the first Mac today, on `127.0.0.1:4100`. Only the Claude Code sessions on that Mac go through it. The user also runs Claude Code on a second Mac and on Roy hosts. Those sessions use no proxy, so they get no account routing, no failover and no records.

This design moves claude-proxy to one central service at `https://claude-proxy.example.com`. Every machine of the user sends its Claude Code traffic there through a small local relay. One database then holds the requests, sessions and costs of every machine, and one set of grants serves every session.

claude-proxy stays a private tool of one user. Anyone can set it up from the public repository for themselves.

## Goals

1. Claude Code on the first Mac, the second Mac and every Roy host sends `api.anthropic.com` traffic through the central claude-proxy. Remote Control stays on.
2. Any machine with an outgoing HTTPS connection can use it. The machine needs no Tailscale access, no VPN and no firewall rule. A Roy VM, which reaches only the internet, can use it.
3. Gateway Auth protects the service. A browser logs in with the cookie, as today. The relay and the menu bar send a token in `X-Gateway-Auth-Token`.
4. When the central claude-proxy does not answer, Claude Code connects to `api.anthropic.com` directly.
5. The history in `~/.claude-proxy/requests.sqlite` on the first Mac moves to the central service. A few minutes of records can be lost during the cut-over.

## Non-goals

- Use by other people on the same service. There is one user.
- Any change to Roy. On a Roy host, the relay comes from the user's dotfiles.
- A Moss firewall change. The service is a normal Moss proxy behind Gateway Auth.

## Anti-goals

- Two proxies that hold the same grants at the same time. A refresh revokes the previous access token of the grant, so two proxies that refresh the same grant log each other out.
- An open tunnel. The central service tunnels only to `api.anthropic.com:443`.
- `ANTHROPIC_BASE_URL`. It turns off Remote Control.
- The mkcert CA of a Mac on a server. Its key lets the holder impersonate any HTTPS site to that Mac.

## Why a relay

Claude Code sends its traffic to an `HTTPS_PROXY` as `CONNECT` tunnels. The cluster's Caddy does not carry a `CONNECT` tunnel, and Caddy is the only public way into a Moss VM. Caddy does carry an HTTP/1.1 upgrade: it passes the request, and after a `101 Switching Protocols` it copies bytes both ways.

The relay therefore turns each `CONNECT` into an HTTP upgrade request to the central service. Gateway Auth checks the upgrade request like any other request.

## Parts

```
Claude Code ──CONNECT──▶ relay (127.0.0.1:4100) ──HTTPS upgrade──▶ Caddy + Gateway Auth ──▶ claude-proxy (docker-host)
                            │                                                                     │
                            └── other hosts: TCP tunnel from this machine                         └──▶ api.anthropic.com
```

### Relay

- The relay is a new package in this repository, `packages/claude_proxy_relay`. It is Node.js with TypeScript type stripping, like the server.
- It listens on `127.0.0.1:4100`. The zsh function and the menu bar keep that address.
- For `CONNECT api.anthropic.com:443`, it sends `GET /_proxy/tunnel` to `https://claude-proxy.example.com` with `Connection: Upgrade`, `Upgrade: claude-proxy-tunnel` and `X-Gateway-Auth-Token`. After a `101`, it answers Claude Code with `200 Connection Established` and copies bytes both ways.
- When the upgrade fails, for any reason, the relay opens a TCP connection to `api.anthropic.com:443` itself and tunnels to it. Claude Code then talks to Anthropic directly, with Anthropic's own certificate. Goal 4 needs no check in the zsh function.
- For `CONNECT` to any other host, the relay opens the TCP tunnel from the local machine. Other traffic never reaches the central service, so `NO_PROXY` needs no internal hosts.
- `GET /_proxy/api/subscription-account-status` on the relay forwards to the central service with the token. The menu bar keeps its URL and needs no token. The zsh function keeps its check of that path.
- Configuration is `~/.claude-proxy-relay/`: `central_url` and `gateway_auth_token`, both mode 600, and `certificate_authority.pem`.
- On a Mac, a launchd agent runs the relay in place of the server agent. On a Roy host, the user's dotfiles install it as a systemd user service.

### Central claude-proxy

- A Docker container on docker-host runs the server. Its data directory, `CLAUDE_PROXY_DIRECTORY`, is a volume.
- docker-host runs Docker 29.2.1 and has 312 GB free. Each app there is a compose project in `/root/<app>`, such as `/root/other_app`, with its settings in `.env` beside `docker-compose.yml`. Its image is built on docker-builder and pushed to `registry.example.com:5000`. The app publishes its port on the host, and a Moss proxy sends its domain to that port.
- claude-proxy follows the same layout: `/root/claude-proxy/docker-compose.yml`, the image `registry.example.com:5000/claude-proxy:<commit>`, the named volume `claude-proxy-data`, `restart: always`, and port 4100 published on the host. Ports 3000 and 30080 are in use.
- New setting `CLAUDE_PROXY_LISTEN_ADDRESS`. The container listens on `0.0.0.0`. The default stays `127.0.0.1`.
- New setting `CLAUDE_PROXY_PUBLIC_HOSTNAME`, here `claude-proxy.example.com`. `isLocalRequest` also accepts that Host, and an Origin of `https://claude-proxy.example.com`.
- New endpoint `GET /_proxy/tunnel` with `Upgrade: claude-proxy-tunnel`. The server answers `101` and gives the socket to `interceptedAnthropicApiServer`, the same path a `CONNECT` to `api.anthropic.com:443` takes today. The endpoint has no target parameter, so it can reach no other host.
- The `CONNECT` listener stays for a local install. A public install does not need it.
- The container publishes port 4100 on docker-host. The cluster's hosts, and every other container on docker-host, can connect to that port without Caddy, so Gateway Auth never sees their requests. claude-proxy therefore asks Gateway Auth itself:
  - New setting `CLAUDE_PROXY_GATEWAY_AUTH_VERIFY_URL`: the `/verify?team_id=<id of gateway-auth-claude-proxy>` URL of the Gateway Auth function, the same URL that Caddy's `forward_auth` calls. A server with a public hostname refuses to start without it.
  - For each request to the public hostname, claude-proxy sends that URL the request's `X-Gateway-Auth-Token` and `Cookie` headers. A 200 serves the request. Any other answer, or no answer within 5 seconds, gives 401.
  - claude-proxy keeps a 200 for 60 seconds, keyed by the SHA-256 of the token or of the `gate_session` cookie.
  - claude-proxy accepts a loopback Host only from a loopback connection, which is the container's own healthcheck.
  - Gateway Auth stays the only thing that checks a token or a login. No new secret exists.
- The log goes to standard output in the container.
- The Resume column of the Sessions tab reads `session_log_file_path` from `~/.claude/projects` on the machine that runs the proxy. The central service has no such directory, so it shows no log file path. The copied `claude --resume` command does not need it. The design removes the log file path and keeps the command.

### Logging in to a subscription account

The redirect URI `http://localhost:<port>/callback` does not reach a central service. The login uses the manual redirect URI of Claude Code's OAuth client, `https://platform.claude.com/oauth/code/callback`. That page shows a code. The web UI gets a field where the user pastes the code, and the server exchanges it as it does now.

### Certificate authority

- A script in this repository makes a CA with a name constraint that permits only `api.anthropic.com`. It also makes the certificate for `api.anthropic.com`, signed by that CA.
- The CA key and the certificate key stay in the volume on docker-host.
- Each machine trusts the CA through `NODE_EXTRA_CA_CERTS=~/.claude-proxy-relay/certificate_authority.pem`, set in the zsh function or in the `env` of `~/.claude/settings.json`.
- A Mac stops using its mkcert certificate for `api.anthropic.com`. The user deletes `~/.claude-proxy/api.anthropic.com*.pem` after the cut-over.

### Project routes

The central service has no home directory of the user, and the machines have different paths. A leading `~` in `project_path_pattern` is no longer expanded. Each pattern is an absolute path, such as `/Users/you/Development/client*` or `/srv/roy/*/worktrees/*`.

### Gateway Auth

The function is `functions/gateway-auth` in gateway-auth-repository.

- `/verify` reads `X-Gateway-Auth-Token`. When the header is present, the function hashes the token with SHA-256. It looks for the hash in the team pref `gateway_auth_tokens` of the team in `team_id`. A match returns 200 with the token's name. No match returns 401. Without the header, the cookie check runs as today.
- The pref is a JSON string, like `allowed_domains`: a list of `{ "name", "sha256", "created_at" }`.
- A script in `functions/gateway-auth` manages the tokens through the Appwrite CLI and the user's console login. It takes the team name and finds the team ID itself.
  - `add <team-name> <token-name>` prints a new token once and stores its hash.
  - `list <team-name>` prints the name and date of each token.
  - `remove <team-name> <token-name>` deletes one token.
- `updatePrefs` replaces the whole object, so the script reads the prefs, changes `gateway_auth_tokens` and writes all of them back. The prefs limit is 64 kB, room for several hundred tokens.
- The team is `gateway-auth-claude-proxy`. Its `allowed_domains` is `["claude-proxy.example.com"]`, and the user is its only member.

### Moss

The user runs:

```sh
moss proxy add --domain claude-proxy.example.com --vm-name docker-host --target-port <port>
moss proxy set-gateway-auth-team-id --domain claude-proxy.example.com --gateway-auth-team-id <id of gateway-auth-claude-proxy>
```

`moss proxy add` opens the firewall rule for the target port from the cluster's hosts. Caddy copies the bytes of an upgraded connection without the `streaming` setting, so the proxy row keeps the defaults.

## Cut-over

1. Deploy the central claude-proxy with an empty volume, and check `https://claude-proxy.example.com/_proxy/` through Gateway Auth.
2. Copy `~/.claude-proxy/requests.sqlite` (1.6 GB after the request body parts migration), `subscription_accounts.yml` and `pricing.yml` to the volume with rsync, while the first Mac proxy still runs.
3. Stop the first Mac proxy: `launchctl bootout gui/$(id -u)/local.claude-proxy.server`.
4. Run rsync again. It copies only the changes since step 2. The WAL is checkpointed when the proxy stops, so `requests.sqlite` alone is complete.
5. Change the project routes to absolute paths.
6. Start the central claude-proxy. It now holds the grants. The first Mac proxy must not start again.
7. Install the relay agent on the first Mac, and check one Claude Code session in the web UI.
8. Install the relay on the second Mac and on each Roy host. The second Mac has never run claude-proxy, so it has no history to merge.

Requests between steps 3 and 7 go directly to Anthropic and are not recorded.

The relay needs Node.js 23.6 or later. The Roy hosts move to Node.js 26 before the deployment.

## Tests

- Relay: a fake central service that answers `101`, one that answers `302` and one that does not answer. The second and third make the relay tunnel directly.
- Server: an upgrade to `/_proxy/tunnel` reaches the intercepted `api.anthropic.com` server. A request with the public Host is accepted, and one with another Host is refused.
- Gateway Auth: a known token, an unknown token, no header with a cookie, and a token of another team.
- The spike of 2026-11-02 showed that the cluster's Caddy passes the upgrade. An echo server on docker-host:4100, behind the Moss proxy `claude-proxy-spike.example.com` with no CDN and no Gateway Auth, answered `101 Switching Protocols` with `Upgrade: claude-proxy-tunnel`. 1 MB of bytes came back through the tunnel. The proxy row had `streaming` off, so the tunnel does not need it. The spike did not cover Gateway Auth in front of the upgrade, because `/verify` does not read the token yet. The Gateway Auth tests do.

