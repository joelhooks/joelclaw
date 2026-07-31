#!/bin/sh
set -eu

LABEL="com.joel.mtu-jumbo"
INTERFACE="${NAS_EXPECTED_INTERFACE:-en0}"
EXPECTED_MTU="${NAS_EXPECTED_MTU:-8192}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_PLIST="${SCRIPT_DIR}/${LABEL}.plist"
TARGET_PLIST="/Library/LaunchDaemons/${LABEL}.plist"

[ "$(id -u)" -eq 0 ] || {
  echo "run with sudo: sudo $0" >&2
  exit 1
}
[ "$INTERFACE" = "en0" ] || {
  echo "the tracked plist targets en0; refusing interface $INTERFACE" >&2
  exit 1
}
[ "$EXPECTED_MTU" = "8192" ] || {
  echo "the proved Flagg MTU contract is 8192; refusing $EXPECTED_MTU" >&2
  exit 1
}

plutil -lint "$SOURCE_PLIST" >/dev/null
install -o root -g wheel -m 0644 "$SOURCE_PLIST" "$TARGET_PLIST"
plutil -lint "$TARGET_PLIST" >/dev/null

launchctl bootout "system/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap system "$TARGET_PLIST"
launchctl kickstart -k "system/${LABEL}" >/dev/null 2>&1 || true

ACTIVE_MTU="$(ifconfig "$INTERFACE" | awk '/ mtu / {for (i=1; i<=NF; i += 1) if ($i == "mtu") {print $(i+1); exit}}')"
[ "$ACTIVE_MTU" = "$EXPECTED_MTU" ] || {
  echo "active ${INTERFACE} MTU is ${ACTIVE_MTU:-unknown}; expected $EXPECTED_MTU" >&2
  exit 1
}

echo "installed ${TARGET_PLIST}; ${INTERFACE} MTU=${ACTIVE_MTU}"
