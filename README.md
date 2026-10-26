# claude-proxy

claude-proxy is a local proxy between Claude Code and the Anthropic API. It records Claude Code's Messages API requests in SQLite. It also sends each project's requests to the Claude subscription account that you chose for that project. When an account reaches a limit, the proxy moves the request to your other account. Claude Code does not see the change.

![The claude-proxy web UI: account usage, recorded requests and their details](docs/web_ui_requests.png)

## How it works

1. Claude Code sends its traffic to `http://127.0.0.1:4100`, because `HTTPS_PROXY` points there. The proxy decrypts the connections to `api.anthropic.com` with a certificate from mkcert. It passes connections to other hosts through unchanged. Claude Code still sees `api.anthropic.com` as its API host, so Remote Control and its other first-party features stay on. With `ANTHROPIC_BASE_URL` set to the proxy, Claude Code turns off Remote Control.
2. For a `/v1/messages` request, the proxy finds the project directory of the request. It picks the first entry of `project_routes` in `subscription_accounts.yml` whose pattern matches. Without a match, it picks `default_subscription_account`.
3. The proxy replaces Claude Code's OAuth token with its own access token for that subscription account. It changes nothing else in the request. The proxy gets its tokens from its own login to each account, described in [Log in to the subscription accounts](#log-in-to-the-subscription-accounts). It never reads, copies or refreshes Claude Code's own login.
4. The proxy moves the request to the next subscription account in two cases. In the first case, an account rejects the request with a 429 for its 5-hour window or a weekly window. In the second case, an account is at or above `failover_utilization` (default 0.98) of its 5-hour or weekly window. The proxy avoids that account before it rejects anything. Programs that use the account without the proxy, such as cron jobs on other servers, keep the last 2%.
5. A rejection for the 5-hour window or the weekly window blocks the account until the window resets. A rejection for the weekly window of one model, such as Fable, blocks only that model on that account. Other errors, such as a 401 or a 529 overload, return to Claude Code unchanged. When every account is blocked, Claude Code gets the rejection of the project's own account.
6. Every response to a request that the proxy sends with its own access token reports the usage of its account in the `anthropic-ratelimit-unified-*` headers. The proxy records them. A response sent with Claude Code's own token does not update any account. The proxy also reads the usage of each account from Anthropic every 5 minutes.
7. The proxy stores each request and its response in `~/.claude-proxy/requests.sqlite`. Bodies are compressed with zstd. The database also stores the Claude Code session ID, the project directory, token counts and an estimated cost. The project directory is the directory that Claude Code started in.

The proxy swaps the token on `/v1/messages*` only. Requests that carry their own API key, and requests to other paths, go to `api.anthropic.com` unchanged with Claude Code's own token. Remote Control, `/usage` and telemetry stay on the account that Claude Code is logged in to.

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

4. Edit `~/.claude-proxy/subscription_accounts.yml`. The first start of the proxy creates this file. See [Configuration](#configuration).

5. Create the certificate for `api.anthropic.com`:

   ```sh
   mkcert -cert-file ~/.claude-proxy/api.anthropic.com.pem -key-file ~/.claude-proxy/api.anthropic.com-key.pem api.anthropic.com
   ```

6. Point Claude Code at the proxy with one of the methods in [Connecting Claude Code](#connecting-claude-code).
7. Log in to each subscription account from the web UI. See [Log in to the subscription accounts](#log-in-to-the-subscription-accounts).

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
		curl --silent --fail --max-time 1 --output /dev/null "$claude_proxy_url/_proxy/api/subscription-account-status"
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
| `subscription_accounts.yml` | The subscription accounts, the project routes and the failover utilization. It holds no credentials. |
| `pricing.yml` | Prices per million tokens for each model. The proxy uses them to estimate costs. |
| `api.anthropic.com.pem`, `api.anthropic.com-key.pem` | The mkcert certificate and key that the proxy uses to decrypt `api.anthropic.com` traffic. |
| `requests.sqlite` | The recorded requests, the grants of the subscription accounts, their last known usage and their blocks. |
| `local.claude-proxy.server.log` | The proxy log. |

Example `subscription_accounts.yml`:

```yaml
subscription_accounts:
  - name: Work
    colour: "#a1c63d"
  - name: Personal
    colour: "#ba8048"
project_routes:
  - project_path_pattern: ~/Development/client*
    subscription_account: Work
  - project_path_pattern: ~/Development/work-dev
    subscription_account: Work
default_subscription_account: Personal
failover_utilization: 0.98
```

| Key | Meaning |
| --- | --- |
| `subscription_accounts` | The accounts, in failover order. Each has a `name` and a `colour`. |
| `project_routes` | The first route whose `project_path_pattern` matches the project wins. The pattern is a glob. `~` means your home directory. A pattern also matches every subdirectory of a matching directory. |
| `default_subscription_account` | The account for a project that no route matches, and for a request with no project. Without this key, such a request tries the accounts in file order and skips each blocked account. |
| `failover_utilization` | A fraction above 0 and at most 1. The proxy avoids an account at or above this fraction of its 5-hour or weekly window. The default is 0.98. |

The project is the directory that Claude Code started in. A request without that information uses the project of the earlier request in the same session.

The proxy reads `subscription_accounts.yml` again at each change, without a restart. After a parse or validation error, or when the file is missing, the proxy keeps the last valid configuration and shows the error in the web UI. When the file is broken at start, the proxy does no routing, and Claude Code uses its own token.

### Log in to the subscription accounts

The proxy needs its own login to each account. This login gives the proxy a grant that is separate from Claude Code's login. The proxy stores the grants in `requests.sqlite` and refreshes them itself.

1. Open the web UI.
2. Press **Log in** on an account.
3. Log in to that Claude account in the browser.
4. Use a different Claude account for each subscription account.

An account without a live grant sends Claude Code's own token unchanged. The web UI shows **Log in** again when the grant stops working.

## Web UI

Open `http://127.0.0.1:4100/_proxy/`.

- The top panel shows each subscription account with its name, email address and colour. It has a usage bar with the time to reset for the 5-hour window, the weekly window and each model window. It shows whether the proxy avoids the account, and until when. It has the **Log in** button, and it lists configuration errors.
- **Requests** lists every request. You can filter by project, model, route, status, date and session. The Route column shows the subscription account that served the request. A failover shows as two attempts. The search box finds text in your prompts, Claude's replies, tool calls and tool output. The filter bar shows the estimated cost of the matching requests: in total, in the last 30 days and in the last 24 hours. A grey project comes from an earlier request in the same session, because the request itself does not name its directory.
- **Sessions** lists Claude Code sessions by project, each with its first prompt and a `claude --resume` command.
- **Costs** shows estimated cost per day and subscription account. Subscription rows show what the same requests would cost at API prices.

## Menu bar

The menu bar shows one pie per subscription account, in file order. Each pie has the colour of its account and shows the weekly usage. A pie turns red when the proxy avoids the account: at the 5-hour or weekly limit, or at `failover_utilization`. When every pie is red, no account can take requests. A grey `!` means the proxy does not answer. The app reads the status once a minute.

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
packages/claude_proxy_server/   Node.js proxy, request database, subscription account routing and web API
packages/claude_proxy_web_ui/   React web UI, served by the proxy under /_proxy/
macos/claude_proxy_menu_bar/    SwiftUI menu bar app
launchd/                        Scripts that install and remove the launchd agents
```

## Security

The proxy listens on 127.0.0.1 only. It rejects requests whose Host is not `127.0.0.1` or `localhost`, and requests from web pages on other origins. The database stores request headers with the `Authorization` and `x-api-key` values replaced by `[redacted]`. It stores the access and refresh tokens of the subscription accounts, so keep `~/.claude-proxy/requests.sqlite` private.

`api.anthropic.com-key.pem` lets any program that reads it impersonate `api.anthropic.com` to every program that trusts the mkcert CA. mkcert makes the file readable by your user only. The proxy decrypts only `api.anthropic.com`. It cannot read the traffic that it tunnels to other hosts.
