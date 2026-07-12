#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LABEL="com.joelclaw.central.session-index-health"
TARGET_SCRIPT="/Users/Shared/joelclaw/bin/session-index-health"
TARGET_PLIST="/Library/LaunchDaemons/${LABEL}.plist"

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run once with sudo: sudo %s\n' "$0" >&2
  exit 2
fi

install -d -o root -g staff -m 0755 /Users/Shared/joelclaw/bin
install -d -o root -g staff -m 0755 /Users/Shared/joelclaw/logs
install -d -o root -g staff -m 0755 /Users/Shared/joelclaw/state/session-index-health
install -o root -g wheel -m 0755 "${SCRIPT_DIR}/session-index-health.sh" "${TARGET_SCRIPT}"
install -o root -g wheel -m 0644 "${SCRIPT_DIR}/${LABEL}.plist" "${TARGET_PLIST}"
plutil -lint "${TARGET_PLIST}"

launchctl bootout "system/${LABEL}" 2>/dev/null || true
launchctl bootstrap system "${TARGET_PLIST}"
launchctl enable "system/${LABEL}"
launchctl kickstart -k "system/${LABEL}"

printf 'Installed %s\n' "${LABEL}"
launchctl print "system/${LABEL}" | grep -E 'state =|runs =|last exit code' || true
