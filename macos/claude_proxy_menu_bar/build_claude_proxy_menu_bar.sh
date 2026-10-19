#!/bin/sh
# Builds ClaudeProxyMenuBar.app into macos/claude_proxy_menu_bar/build/.
set -eu

menu_bar_source_directory="$(cd "$(dirname "$0")" && pwd)"
menu_bar_app_path="$menu_bar_source_directory/build/ClaudeProxyMenuBar.app"

rm -rf "$menu_bar_app_path"
mkdir -p "$menu_bar_app_path/Contents/MacOS"
cp "$menu_bar_source_directory/Info.plist" "$menu_bar_app_path/Contents/Info.plist"
swiftc -O -parse-as-library -swift-version 5 \
  -target "$(uname -m)-apple-macos13.0" \
  "$menu_bar_source_directory/ClaudeProxyMenuBar.swift" \
  -o "$menu_bar_app_path/Contents/MacOS/ClaudeProxyMenuBar"
codesign --force --sign - "$menu_bar_app_path"
echo "Built $menu_bar_app_path"
