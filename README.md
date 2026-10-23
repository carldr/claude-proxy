# claude-proxy

claude-proxy is a local proxy between Claude Code and the Anthropic API. It records Claude Code's Messages API requests in SQLite. When your weekly subscription limit is almost used, it sends Claude Code's subscription traffic to an API key. Claude Code does not see the change.

![The claude-proxy web UI: the routing panel with weekly subscription usage, and the request log](docs/web_ui_requests.png)

## How it works

1. Claude Code sends its traffic to `http://127.0.0.1:4100`, because `HTTPS_PROXY` points there. The proxy decrypts the connections to `api.anthropic.com` with a certificate from mkcert. It passes connections to other hosts through unchanged. Claude Code still sees `api.anthropic.com` as its API host, so Remote Control and its other first-party features stay on. With `ANTHROPIC_BASE_URL` set to the proxy, Claude Code turns off Remote Control.
2. The proxy reads the routing mode and the weekly subscription usage, and picks the first route:
   - **Auto**: the subscription, until it refuses a request for the weekly limit. After that, the API keys in `routes.yml`, with the subscription last.
   - **Subscription only**: the subscription.
   - **API key only**: the API keys in `routes.yml`.
3. On an API key route, the proxy replaces Claude Code's OAuth token with the route's API key.
4. The proxy moves to the next route in two cases only:
   - the subscription returns 429 for the weekly window;
   - an API key returns 401.

   Other errors, such as a 429 for the 5-hour window or a 529 overload, go back to Claude Code unchanged. When no route is left, Claude Code gets the last error.
5. Every subscription response reports weekly usage in its `anthropic-ratelimit-unified-7d-utilization` header. The proxy records this value.
6. While the weekly limit is reached, the proxy reads your usage from Anthropic every 5 minutes. In auto mode, traffic returns to the subscription when usage is below 100%, or when the weekly window resets.
7. The proxy stores each request and its response in `~/.claude-proxy/requests.sqlite`. Bodies are compressed with zstd. The database also stores the Claude Code session ID, the project directory, token counts and an estimated cost. The project directory is the directory that Claude Code started in.

Requests that carry their own API key, and requests to paths other than `/v1/messages`, go to `api.anthropic.com` unchanged.

## Requirements

- macOS 13 or later
- Node.js 23.6 or later, for TypeScript type stripping and `node:sqlite`
- pnpm
- Xcode command line tools, for `swiftc`
- mkcert, with its local CA installed by `mkcert -install`

## Install

1. Install the dependencies:

   ```sh
   pnpm install
   ```

2. Build the web UI and the menu bar app:

   ```sh
   pnpm build
   ```

3. Install the launchd agents. They start the proxy and the menu bar app now and at each login:

   ```sh
   pnpm install_launchd_agents
   ```

4. Add your API keys to `~/.claude-proxy/routes.yml`. The first start of the proxy creates this file.

5. Create the certificate for `api.anthropic.com`:

   ```sh
   mkcert -cert-file ~/.claude-proxy/api.anthropic.com.pem -key-file ~/.claude-proxy/api.anthropic.com-key.pem api.anthropic.com
   ```

6. Point Claude Code at the proxy with one of the methods in [Connecting Claude Code](#connecting-claude-code).

Run `pnpm install_launchd_agents` again after a Node.js upgrade, because the agent stores the path to `node`.

## Connecting Claude Code

Claude Code reaches the proxy in one of two ways:

- **As its HTTPS proxy.** `HTTPS_PROXY` sends every HTTPS connection to the proxy as a `CONNECT` tunnel. The proxy decrypts `api.anthropic.com` and passes other hosts through. Claude Code still sees `api.anthropic.com` as its API host, so Remote Control stays on.
- **As its API base URL.** `ANTHROPIC_BASE_URL` sends only API requests to the proxy, in plain HTTP. No certificate is needed. Claude Code turns off Remote Control for any base URL other than `api.anthropic.com`.

Claude Code passes its environment to the commands that it runs. With `HTTPS_PROXY`, their HTTPS traffic also goes through the proxy tunnel. While the proxy restarts, their connections fail.

| Method | What goes through the proxy | Remote Control | When the proxy is down |
| --- | --- | --- | --- |
| zsh function | Claude Code started from zsh, and the commands it runs | On | Claude Code connects directly |
| `env` in `~/.claude/settings.json` | Claude Code from every launcher, including IDEs, and the commands it runs | On | Claude Code fails until you remove the settings |
| `export` in the shell profile | Every program started from the shell, such as curl, git and npm | On | All HTTPS from the shell fails |
| `ANTHROPIC_BASE_URL` | Claude Code's API requests only | Off | Claude Code fails |

The zsh function is the recommended method. It changes nothing outside Claude Code, and it checks the proxy at each launch.

`NODE_EXTRA_CA_CERTS` lets Node.js programs that Claude Code runs trust the mkcert certificate. Claude Code itself trusts the mkcert CA through the macOS keychain, after `mkcert -install`.

### zsh function

Add this function to `~/.zshrc`:

```zsh
#  Sends Claude Code through claude-proxy when the proxy answers on port 4100.
#  claude-proxy is the HTTPS_PROXY, so Claude Code keeps api.anthropic.com as
#  its API host, and Remote Control stays on.  The check runs at each launch, so a
#  stopped proxy never leaves claude pointing at a dead address.  An
#  HTTPS_PROXY or ANTHROPIC_BASE_URL that is already set wins.
function claude() {
	local claude_proxy_url="http://127.0.0.1:4100"

	if [[ -z "$HTTPS_PROXY$ANTHROPIC_BASE_URL" ]] &&
		curl --silent --fail --max-time 1 --output /dev/null "$claude_proxy_url/_proxy/api/routing-status"
	then
		HTTPS_PROXY="$claude_proxy_url" NO_PROXY="localhost,127.0.0.1" NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" \
			command claude "$@"
	else
		command claude "$@"
	fi
}
```

### `env` in `~/.claude/settings.json`

Add these keys to the `env` object. Replace the CA path with the output of `mkcert -CAROOT`, followed by `/rootCA.pem`:

```json
{
  "env": {
    "HTTPS_PROXY": "http://127.0.0.1:4100",
    "NO_PROXY": "localhost,127.0.0.1",
    "NODE_EXTRA_CA_CERTS": "/Users/you/Library/Application Support/mkcert/rootCA.pem"
  }
}
```

### `export` in the shell profile

```sh
export HTTPS_PROXY=http://127.0.0.1:4100
export NO_PROXY=localhost,127.0.0.1
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

### `ANTHROPIC_BASE_URL`

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:4100
```

## Configuration

All configuration is in `~/.claude-proxy/`. The proxy reads each file again when the file changes.

| File | Contents |
| --- | --- |
| `routes.yml` | The API key routes, in failover order. Each route has `name`, `letter`, `colour`, `base_url` and `api_key`. |
| `pricing.yml` | Prices per million tokens for each model. The proxy uses them to estimate costs. |
| `api.anthropic.com.pem`, `api.anthropic.com-key.pem` | The mkcert certificate and key that the proxy uses to decrypt `api.anthropic.com` traffic. |
| `requests.sqlite` | The recorded requests, the routing mode, the selected API key and the last known weekly usage. |
| `local.claude-proxy.server.log` | The proxy log. |

Example `routes.yml`:

```yaml
api_key_routes:
  - name: anthropic-personal
    letter: P
    colour: "#3b82f6"
    base_url: https://api.anthropic.com
    api_key: sk-ant-api03-...
```

## Web UI

Open `http://127.0.0.1:4100/_proxy/`.

- The top panel shows the active route and the weekly usage. It also has the routing mode switch and the selector for the first API key.
- **Requests** lists every request. You can filter by project, model, route, status, date and session. The search box finds text in your prompts, Claude's replies, tool calls and tool output. The filter bar shows the estimated cost of the matching requests: in total, in the last 30 days and in the last 24 hours. A grey project comes from an earlier request in the same session, because the request itself does not name its directory.
- **Sessions** lists Claude Code sessions by project, each with its first prompt and a `claude --resume` command.
- **Costs** shows estimated cost per day and route. Subscription rows show what the same requests would cost at API prices.

## Menu bar

The menu bar shows the active route: `S` on a white dot for the subscription, or the route's letter on its colour. A grey `!` means the proxy does not answer. The app reads the route once a minute.

## Commands

| Command | Action |
| --- | --- |
| `pnpm build` | Builds the web UI and the menu bar app. |
| `pnpm start` | Runs the proxy in the foreground. |
| `pnpm test` | Runs the proxy tests against fake upstream servers. |
| `pnpm typecheck` | Type-checks both packages. |
| `pnpm dev:server` | Runs the proxy and restarts it when a source file changes. |
| `pnpm dev:web_ui` | Runs the Vite dev server for the web UI, with `/_proxy/api` sent to port 4100. |
| `pnpm install_launchd_agents` | Installs and starts the launchd agents. |
| `pnpm uninstall_launchd_agents` | Stops and removes the launchd agents. Your data stays in `~/.claude-proxy`. |

## Project layout

```
packages/claude_proxy_server/   Node.js proxy, request database, routing and web API
packages/claude_proxy_web_ui/   React web UI, served by the proxy under /_proxy/
macos/claude_proxy_menu_bar/    SwiftUI menu bar app
launchd/                        Scripts that install and remove the launchd agents
```

## Security

The proxy listens on 127.0.0.1 only. It rejects requests whose Host is not `127.0.0.1` or `localhost`, and requests from web pages on other origins. The database stores request headers with the `Authorization` and `x-api-key` values replaced by `[redacted]`.

`api.anthropic.com-key.pem` lets any program that reads it impersonate `api.anthropic.com` to every program that trusts the mkcert CA. mkcert makes the file readable by your user only. The proxy decrypts only `api.anthropic.com`. It cannot read the traffic that it tunnels to other hosts.
