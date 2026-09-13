#!/bin/sh
# Install or remove the com.joel.imsg-mcp LaunchAgent. The job runs the pinned node copy
# from /Applications/imsg-mcp.app directly (no shell wrapper) so Full Disk Access granted
# to that app bundle covers the server and its imsg children. The server leases its own
# bearer token from `secrets`; nothing secret lives in the plist.
set -eu

label="com.joel.imsg-mcp"
plist="$HOME/Library/LaunchAgents/$label.plist"
logs="$HOME/.joelclaw/logs"
port="${IMSG_MCP_PORT:-4793}"
app_node="/Applications/imsg-mcp.app/Contents/MacOS/node"
imsg_bin="${IMSG_MCP_BIN:-/opt/homebrew/bin/imsg}"
uid=$(id -u)

case "${1:-}" in
  install)
    package_root=${2:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}
    server_source="$package_root/src/http-server.ts"
    curl_bin=${CURL_BIN:-$(command -v curl || true)}
    test -n "$curl_bin" || { printf 'curl not found on PATH; set CURL_BIN\n' >&2; exit 1; }
    plist_stage="$plist.new.$$"
    plist_backup="$plist.backup.$$"
    old_plist=false
    old_running=false
    rollback_needed=false

    if [ ! -x "$app_node" ]; then
      printf '%s is missing; run scripts/install-app-bundle.sh first\n' "$app_node" >&2
      exit 1
    fi
    test -f "$server_source" || { printf 'missing %s\n' "$server_source" >&2; exit 1; }
    test -x "$imsg_bin" || { printf 'imsg not executable at %s\n' "$imsg_bin" >&2; exit 1; }

    wait_for_unloaded() {
      attempt=0
      while launchctl print "gui/$uid/$label" >/dev/null 2>&1; do
        if [ "$attempt" -ge 20 ]; then return 1; fi
        attempt=$((attempt + 1))
        sleep 0.1
      done
    }

    finish() {
      status=$?
      trap - EXIT
      if [ "$rollback_needed" = true ]; then
        launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
        wait_for_unloaded || true
        if [ "$old_plist" = true ]; then mv "$plist_backup" "$plist"; else rm -f "$plist"; fi
        if [ "$old_running" = true ] && [ -f "$plist" ]; then
          launchctl bootstrap "gui/$uid" "$plist" || true
        fi
      fi
      rm -f "$plist_stage" "$plist_backup"
      exit "$status"
    }
    trap finish EXIT
    trap 'exit 1' HUP INT TERM

    # Validate the entry module loads under the pinned node without starting a listener.
    "$app_node" --input-type=module -e \
      'import { pathToFileURL } from "node:url"; const source = process.argv[1]; process.argv[1] = "installer-validation"; await import(pathToFileURL(source).href)' \
      "$server_source"

    mkdir -p "$HOME/Library/LaunchAgents" "$logs"
    cat >"$plist_stage" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$app_node</string>
    <string>$server_source</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key><string>production</string>
    <key>IMSG_MCP_PORT</key><string>$port</string>
    <key>IMSG_MCP_BIN</key><string>$imsg_bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$logs/imsg-mcp.log</string>
  <key>StandardErrorPath</key><string>$logs/imsg-mcp.error.log</string>
</dict>
</plist>
PLIST
    plutil -lint "$plist_stage" >/dev/null

    if [ -f "$plist" ]; then cp -p "$plist" "$plist_backup"; old_plist=true; fi
    if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then old_running=true; fi

    rollback_needed=true
    mv "$plist_stage" "$plist"
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    if ! wait_for_unloaded; then
      printf 'imsg MCP did not unload before activation\n' >&2
      exit 1
    fi

    activation_ok=false
    if launchctl bootstrap "gui/$uid" "$plist"; then
      attempt=0
      while [ "$attempt" -lt 60 ]; do
        if "$curl_bin" --fail --silent --max-time 1 "http://127.0.0.1:$port/healthz" >/dev/null; then
          activation_ok=true
          break
        fi
        attempt=$((attempt + 1))
        sleep 0.25
      done
    fi

    if [ "$activation_ok" != true ]; then
      printf 'imsg MCP activation failed; restoring previous service (see %s/imsg-mcp.error.log)\n' "$logs" >&2
      exit 1
    fi

    rollback_needed=false
    rm -f "$plist_backup"
    printf 'imsg-mcp listening on http://127.0.0.1:%s (label %s)\n' "$port" "$label"
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
