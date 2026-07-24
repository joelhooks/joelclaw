#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LABEL="com.joelclaw.central.log-rotation"
TARGET_SCRIPT="/Users/Shared/joelclaw/bin/rotate-service-logs"
TARGET_PLIST="/Library/LaunchDaemons/${LABEL}.plist"
ACKNOWLEDGED=0

if [ "${1:-}" = "--acknowledge-first-rotation" ] && [ "$#" -eq 1 ]; then
  ACKNOWLEDGED=1
elif [ "$#" -ne 0 ]; then
  printf 'Usage: sudo %s --acknowledge-first-rotation\n' "$0" >&2
  exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run once with sudo: sudo %s --acknowledge-first-rotation\n' "$0" >&2
  exit 2
fi

if [ "${ACKNOWLEDGED}" -ne 1 ]; then
  cat >&2 <<'NOTICE'
The first run will rotate the current Inngest and Typesense logs. An oversized
log keeps only its newest 64 MiB archive before the live inode is truncated.
Review the current 3.5 GB Inngest log before acknowledging this operation.
NOTICE
  exit 2
fi

id joelclaw >/dev/null 2>&1
test -x /usr/bin/perl
install -d -o root -g staff -m 0755 /Users/Shared/joelclaw/bin
install -d -o joelclaw -g staff -m 0750 /Users/Shared/joelclaw/state/log-rotation
install -o root -g wheel -m 0755 "${SCRIPT_DIR}/rotate-service-logs.sh" "${TARGET_SCRIPT}"
install -o root -g wheel -m 0644 "${SCRIPT_DIR}/${LABEL}.plist" "${TARGET_PLIST}"
plutil -lint "${TARGET_PLIST}"

launchctl bootout "system/${LABEL}" 2>/dev/null || true
launchctl bootstrap system "${TARGET_PLIST}"
launchctl enable "system/${LABEL}"
launchctl kickstart "system/${LABEL}"

printf 'Installed %s\n' "${LABEL}"
launchctl print "system/${LABEL}" | grep -E 'state =|runs =|last exit code' || true
