#!/bin/sh
set -eu

LABEL="com.joelclaw.local-convex.lan-forwarder"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_FORWARDER="${SCRIPT_DIR}/local-convex-lan-forwarder.mjs"
SOURCE_PLIST="${SCRIPT_DIR}/${LABEL}.plist.template"
TARGET_FORWARDER="/Users/Shared/joelclaw/bin/local-convex-lan-forwarder.mjs"
TARGET_PLIST="/Library/LaunchDaemons/${LABEL}.plist"
LOG_DIR="/Users/Shared/joelclaw/logs/convex"

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

install -d -o root -g staff -m 0755 /Users/Shared/joelclaw/bin
install -d -o joel -g staff -m 0755 "$LOG_DIR"
install -o root -g staff -m 0755 "$SOURCE_FORWARDER" "$TARGET_FORWARDER"
plutil -lint "$SOURCE_PLIST" >/dev/null
install -o root -g wheel -m 0644 "$SOURCE_PLIST" "$TARGET_PLIST"
plutil -lint "$TARGET_PLIST" >/dev/null

launchctl bootout "system/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap system "$TARGET_PLIST"
launchctl kickstart -k "system/${LABEL}" >/dev/null
launchctl print "system/${LABEL}" >/dev/null

echo "installed ${TARGET_PLIST}"
echo "forwarding 192.168.1.10:{3210,3211,6791} to loopback before GUI login"
