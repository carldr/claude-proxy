#!/bin/sh
# Installs and starts two launchd agents that run at login:
#   local.claude-proxy.relay     runs claude_proxy_relay on port 4100, and restarts it if it stops.
#   local.claude-proxy.menu-bar  runs ClaudeProxyMenuBar.app, and restarts it if it crashes.
# The relay agent replaces local.claude-proxy.server. The script removes the server agent only after
# it finds central_url and gateway_auth_token in ~/.claude-proxy-relay, so a machine without them keeps its local proxy.
# Run "pnpm build" first. Run this script again after a Node.js upgrade, because the agents store the node path.
set -eu

repository_directory="$(cd "$(dirname "$0")/.." && pwd)"
launch_agents_directory="$HOME/Library/LaunchAgents"
claude_proxy_relay_directory="$HOME/.claude-proxy-relay"
node_path="$(command -v node)"
menu_bar_executable_path="$repository_directory/macos/claude_proxy_menu_bar/build/ClaudeProxyMenuBar.app/Contents/MacOS/ClaudeProxyMenuBar"
user_domain="gui/$(id -u)"

if [ ! -x "$menu_bar_executable_path" ]; then
  echo "Run \"pnpm build\" in $repository_directory first." >&2
  exit 1
fi

missing_relay_files=""
for relay_file_name in central_url gateway_auth_token; do
  if [ ! -s "$claude_proxy_relay_directory/$relay_file_name" ]; then
    missing_relay_files="$missing_relay_files $claude_proxy_relay_directory/$relay_file_name"
  fi
done
if [ -n "$missing_relay_files" ]; then
  echo "The relay needs these files, and they are missing or empty:" >&2
  for missing_relay_file in $missing_relay_files; do
    echo "  $missing_relay_file" >&2
  done
  echo "Nothing changed. See \"Relay\" in README.md." >&2
  exit 1
fi

for relay_file_name in central_url gateway_auth_token proxy_credential; do
  relay_file_path="$claude_proxy_relay_directory/$relay_file_name"
  if [ -f "$relay_file_path" ]; then
    relay_file_mode="$(printf '%03d' "$(stat -f %Lp "$relay_file_path")")"
    case "${relay_file_mode#?}" in
      00) ;;
      *)
        echo "The relay refuses to start, because group or others can read $relay_file_path." >&2
        echo "Run: chmod 600 $relay_file_path" >&2
        echo "Nothing changed." >&2
        exit 1
        ;;
    esac
  fi
done

mkdir -p "$launch_agents_directory" "$claude_proxy_relay_directory"

write_launch_agent() {
  launch_agent_label="$1"
  launch_agent_program_arguments="$2"
  launch_agent_keep_alive="$3"
  launch_agent_path="$launch_agents_directory/$launch_agent_label.plist"
  cat > "$launch_agent_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$launch_agent_label</string>
  <key>ProgramArguments</key>
  <array>$launch_agent_program_arguments
  </array>
  <key>WorkingDirectory</key>
  <string>$repository_directory</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  $launch_agent_keep_alive
  <key>StandardOutPath</key>
  <string>$claude_proxy_relay_directory/$launch_agent_label.log</string>
  <key>StandardErrorPath</key>
  <string>$claude_proxy_relay_directory/$launch_agent_label.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "$user_domain/$launch_agent_label" 2>/dev/null || true
  # launchctl bootstrap fails with error 5 until the agent that bootout stopped has unloaded.
  bootstrap_attempts=0
  until launchctl bootstrap "$user_domain" "$launch_agent_path" 2>/dev/null; do
    bootstrap_attempts=$((bootstrap_attempts + 1))
    if [ "$bootstrap_attempts" -ge 10 ]; then
      launchctl bootstrap "$user_domain" "$launch_agent_path"
    fi
    sleep 1
  done
  echo "Started $launch_agent_label ($launch_agent_path)"
}

launchctl bootout "$user_domain/local.claude-proxy.server" 2>/dev/null || true
rm -f "$launch_agents_directory/local.claude-proxy.server.plist"

write_launch_agent local.claude-proxy.relay "
    <string>$node_path</string>
    <string>$repository_directory/packages/claude_proxy_relay/src/main.ts</string>" "<true/>"

write_launch_agent local.claude-proxy.menu-bar "
    <string>$menu_bar_executable_path</string>" "<dict><key>SuccessfulExit</key><false/></dict>"

echo "Relay log: $claude_proxy_relay_directory/local.claude-proxy.relay.log"
echo "Claude Code uses the relay through HTTPS_PROXY. See \"Connecting Claude Code\" in README.md."
