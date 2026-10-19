#!/bin/sh
# Installs and starts two launchd agents that run at login:
#   local.claude-proxy.server    runs claude_proxy_server on port 4100, and restarts it if it stops.
#   local.claude-proxy.menu-bar  runs ClaudeProxyMenuBar.app, and restarts it if it crashes.
# Run "pnpm build" first. Run this script again after a Node.js upgrade, because the agent stores the node path.
set -eu

repository_directory="$(cd "$(dirname "$0")/.." && pwd)"
launch_agents_directory="$HOME/Library/LaunchAgents"
claude_proxy_directory="$HOME/.claude-proxy"
node_path="$(command -v node)"
menu_bar_executable_path="$repository_directory/macos/claude_proxy_menu_bar/build/ClaudeProxyMenuBar.app/Contents/MacOS/ClaudeProxyMenuBar"
user_domain="gui/$(id -u)"

if [ ! -f "$repository_directory/packages/claude_proxy_web_ui/dist/index.html" ] || [ ! -x "$menu_bar_executable_path" ]; then
  echo "Run \"pnpm build\" in $repository_directory first." >&2
  exit 1
fi

mkdir -p "$launch_agents_directory" "$claude_proxy_directory"

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
  <string>$claude_proxy_directory/$launch_agent_label.log</string>
  <key>StandardErrorPath</key>
  <string>$claude_proxy_directory/$launch_agent_label.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "$user_domain/$launch_agent_label" 2>/dev/null || true
  launchctl bootstrap "$user_domain" "$launch_agent_path"
  echo "Started $launch_agent_label ($launch_agent_path)"
}

write_launch_agent local.claude-proxy.server "
    <string>$node_path</string>
    <string>$repository_directory/packages/claude_proxy_server/src/main.ts</string>" "<true/>"

write_launch_agent local.claude-proxy.menu-bar "
    <string>$menu_bar_executable_path</string>" "<dict><key>SuccessfulExit</key><false/></dict>"

echo "Web UI: http://127.0.0.1:4100/_proxy/"
echo "Send Claude Code through the proxy with: export ANTHROPIC_BASE_URL=http://127.0.0.1:4100"
