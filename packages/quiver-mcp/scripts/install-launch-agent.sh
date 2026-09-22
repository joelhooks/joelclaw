#!/bin/sh
# Install or remove the com.joel.quiver-mcp LaunchAgent. The job runs the resolved node
# binary against src/http-server.ts. Both secrets (bearer and Quiver API key) are leased
# from agent-secrets at startup; nothing secret lives in the plist.
set -eu

label="com.joel.quiver-mcp"
plist="$HOME/Library/LaunchAgents/$label.plist"
logs="$HOME/.joelclaw/logs"
port="${QUIVER_MCP_PORT:-4794}"
uid=$(id -u)

case "${1:-}" in
  install)
    package_root=${2:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}
    server_source="$package_root/src/http-server.ts"
    node_bin=${QUIVER_MCP_NODE:-$(command -v node || true)}
    test -n "$node_bin" || { printf 'node not found on PATH; set QUIVER_MCP_NODE\n' >&2; exit 1; }
    node_bin=$(cd "$(dirname "$node_bin")" && pwd -P)/$(basename "$node_bin")
    while [ -L "$node_bin" ]; do
      target=$(readlink "$node_bin")
      case "$target" in
        /*) node_bin=$target ;;
        *) node_bin=$(cd "$(dirname "$node_bin")" && cd "$(dirname "$target")" && pwd -P)/$(basename "$target") ;;
      esac
    done
    test -x "$node_bin" || { printf 'node is not executable at %s\n' "$node_bin" >&2; exit 1; }
    test -f "$server_source" || { printf 'missing %s\n' "$server_source" >&2; exit 1; }
    curl_bin=${CURL_BIN:-$(command -v curl || true)}
    test -n "$curl_bin" || { printf 'curl not found on PATH; set CURL_BIN\n' >&2; exit 1; }

    # Validate the entry module loads without starting a listener.
    "$node_bin" --input-type=module -e \
      'import { pathToFileURL } from "node:url"; const source = process.argv[1]; process.argv[1] = "installer-validation"; await import(pathToFileURL(source).href)' \
      "$server_source"

    mkdir -p "$HOME/Library/LaunchAgents" "$logs"
    plist_stage="$plist.new.$$"
    cat >"$plist_stage" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$server_source</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key><string>production</string>
    <key>QUIVER_MCP_PORT</key><string>$port</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$logs/quiver-mcp.log</string>
  <key>StandardErrorPath</key><string>$logs/quiver-mcp.error.log</string>
</dict>
</plist>
PLIST
    plutil -lint "$plist_stage" >/dev/null
    mv "$plist_stage" "$plist"

    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    attempt=0
    while launchctl print "gui/$uid/$label" >/dev/null 2>&1; do
      if [ "$attempt" -ge 20 ]; then printf 'previous %s did not unload\n' "$label" >&2; exit 1; fi
      attempt=$((attempt + 1))
      sleep 0.1
    done
    launchctl bootstrap "gui/$uid" "$plist"

    attempt=0
    while [ "$attempt" -lt 80 ]; do
      if "$curl_bin" --fail --silent --max-time 1 "http://127.0.0.1:$port/healthz" >/dev/null; then
        printf 'quiver-mcp listening on http://127.0.0.1:%s (label %s)\n' "$port" "$label"
        exit 0
      fi
      attempt=$((attempt + 1))
      sleep 0.25
    done
    printf 'quiver MCP did not answer /healthz; see %s/quiver-mcp.error.log\n' "$logs" >&2
    exit 1
    ;;
  uninstall)
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    rm -f "$plist"
    ;;
  *)
    printf 'usage: %s install|uninstall [package-root]\n' "$0" >&2
    exit 2
    ;;
esac
