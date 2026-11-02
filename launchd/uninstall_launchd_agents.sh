#!/bin/sh
# Stops and removes the launchd agents that install_launchd_agents.sh created.
# It also removes local.claude-proxy.server, the agent of an earlier version.
# The files in ~/.claude-proxy and ~/.claude-proxy-relay stay in place.
set -eu

user_domain="gui/$(id -u)"
for launch_agent_label in local.claude-proxy.relay local.claude-proxy.server local.claude-proxy.menu-bar; do
  launchctl bootout "$user_domain/$launch_agent_label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$launch_agent_label.plist"
  echo "Removed $launch_agent_label"
done
