#!/bin/sh
set -eu

LABEL="com.joelclaw.local-convex.lan-forwarder"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_FORWARDER="${SCRIPT_DIR}/local-convex-lan-forwarder.mjs"
SOURCE_PLIST="${SCRIPT_DIR}/${LABEL}.plist.template"
TARGET_FORWARDER="/Users/Shared/joelclaw/bin/local-convex-lan-forwarder.mjs"
TARGET_PLIST="/Library/LaunchDaemons/${LABEL}.plist"
LOG_DIR="/Users/Shared/joelclaw/logs/convex"

if [ "${1:-}" = --help ]; then
  printf '%s\n' "Usage: sudo LAN_BIND_IP=… CONVEX_SERVICE_USER=… CONVEX_SERVICE_HOME=… sh $0"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || {
  echo "run with sudo: sudo $0" >&2
  exit 1
}
[ -x /opt/homebrew/bin/node ] || {
  echo "/opt/homebrew/bin/node is required" >&2
  exit 1
}
[ -f "$SOURCE_FORWARDER" ] || {
  echo "missing forwarder: $SOURCE_FORWARDER" >&2
  exit 1
}
[ -f "$SOURCE_PLIST" ] || {
  echo "missing plist template: $SOURCE_PLIST" >&2
  exit 1
}

: "${LAN_BIND_IP:?set the local LAN bind address}" "${CONVEX_SERVICE_USER:?set the local service account}" \
  "${CONVEX_SERVICE_HOME:?set the service account home}"
/opt/homebrew/bin/node -e 'const a = process.argv[1]; if (require("node:net").isIP(a) !== 4 || a === "0.0.0.0") process.exit(1)' "$LAN_BIND_IP"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
cp "$SOURCE_PLIST" "$rendered"
plutil -replace EnvironmentVariables.LAN_BIND_IP -string "$LAN_BIND_IP" "$rendered"
plutil -replace EnvironmentVariables.HOME -string "$CONVEX_SERVICE_HOME" "$rendered"
plutil -replace UserName -string "$CONVEX_SERVICE_USER" "$rendered"
plutil -lint "$rendered" >/dev/null
install -d -o root -g staff -m 0755 /Users/Shared/joelclaw/bin
install -d -o "$CONVEX_SERVICE_USER" -g staff -m 0755 "$LOG_DIR"
install -o root -g staff -m 0755 "$SOURCE_FORWARDER" "$TARGET_FORWARDER"
install -o root -g wheel -m 0644 "$rendered" "$TARGET_PLIST"
plutil -lint "$TARGET_PLIST" >/dev/null

launchctl bootout "system/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap system "$TARGET_PLIST"
launchctl kickstart -k "system/${LABEL}" >/dev/null
launchctl print "system/${LABEL}" >/dev/null

echo "installed ${TARGET_PLIST}"
echo "forwarding configured LAN listeners to loopback before GUI login"
