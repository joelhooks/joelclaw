#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

BOOTSTRAP=0
case "${1:-}" in
  "") ;;
  --bootstrap) BOOTSTRAP=1 ;;
  --no-bootstrap) BOOTSTRAP=0 ;;
  *) fail "usage: $0 [--bootstrap|--no-bootstrap]" ;;
esac

LABEL="com.joelclaw.central.nas-mounts"
SRC="${CENTRAL_DIR}/launchd/${LABEL}.plist.template"
DST="/Library/LaunchDaemons/${LABEL}.plist"

require_root() {
  [[ "$(id -u)" == "0" ]] || fail "run with sudo: sudo $0 [--bootstrap]"
}

bootout_if_loaded() {
  launchctl print "system/${LABEL}" >/dev/null 2>&1 || return 0
  launchctl bootout "system/${LABEL}" >/dev/null 2>&1 \
    || launchctl bootout system "$DST" >/dev/null 2>&1 \
    || true
}

require_root
require_command plutil
require_command launchctl

[[ -f "$SRC" ]] || fail "missing launchd template: ${SRC}"
plutil -lint "$SRC" >/dev/null
install -m 644 "$SRC" "$DST"
chown root:wheel "$DST"
plutil -lint "$DST" >/dev/null
log "installed ${DST}"

mkdir -p "$CENTRAL_NAS_NVME_MOUNT" "$CENTRAL_NAS_HDD_MOUNT" "$CENTRAL_LOG_DIR"
chown root:wheel "$CENTRAL_NAS_NVME_MOUNT" "$CENTRAL_NAS_HDD_MOUNT"
chmod 755 "$CENTRAL_NAS_NVME_MOUNT" "$CENTRAL_NAS_HDD_MOUNT"
chown "${SERVICE_USER}:${SERVICE_GROUP}" "$CENTRAL_LOG_DIR"
chmod 750 "$CENTRAL_LOG_DIR"
log "prepared mount points: ${CENTRAL_NAS_NVME_MOUNT}, ${CENTRAL_NAS_HDD_MOUNT}"

if [[ "$BOOTSTRAP" == "1" ]]; then
  launchctl enable "system/${LABEL}" || true
  bootout_if_loaded
  launchctl bootstrap system "$DST"
  launchctl kickstart -k "system/${LABEL}" >/dev/null 2>&1 || true
  launchctl print "system/${LABEL}" >/dev/null
  log "bootstrapped system/${LABEL}"
else
  bootout_if_loaded
  launchctl disable "system/${LABEL}" || true
  log "installed and disabled system/${LABEL}; pass --bootstrap after validating NAS exports"
fi
