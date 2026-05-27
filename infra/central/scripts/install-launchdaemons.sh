#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

BOOTSTRAP=0
case "${1:-}" in
  "") ;;
  --bootstrap) BOOTSTRAP=1 ;;
  --no-bootstrap) BOOTSTRAP=0 ;;
  *) fail "usage: $0 [--bootstrap|--no-bootstrap]" ;;
esac

LABELS=(
  com.joelclaw.central.colima
  com.joelclaw.central.compose
  com.joelclaw.central.health
)

require_root() {
  [[ "$(id -u)" == "0" ]] || fail "run with sudo: sudo $0 [--bootstrap]"
}

bootout_if_loaded() {
  local label="$1"
  local plist_path="/Library/LaunchDaemons/${label}.plist"
  launchctl print "system/${label}" >/dev/null 2>&1 || return 0
  launchctl bootout "system/${label}" >/dev/null 2>&1 \
    || launchctl bootout system "$plist_path" >/dev/null 2>&1 \
    || true
}

disable_one() {
  local label="$1"
  bootout_if_loaded "$label"
  launchctl disable "system/${label}" || true
  log "disabled system/${label} until Gate 4 bootstrap"
}

enable_one() {
  local label="$1"
  launchctl enable "system/${label}" || true
}

install_one() {
  local label="$1"
  local src="${CENTRAL_DIR}/launchd/${label}.plist.template"
  local dst="/Library/LaunchDaemons/${label}.plist"

  [[ -f "$src" ]] || fail "missing launchd template: ${src}"
  plutil -lint "$src" >/dev/null
  install -m 644 "$src" "$dst"
  chown root:wheel "$dst"
  plutil -lint "$dst" >/dev/null
  log "installed ${dst}"
}

bootstrap_one() {
  local label="$1"
  local plist_path="/Library/LaunchDaemons/${label}.plist"

  enable_one "$label"
  bootout_if_loaded "$label"
  launchctl bootstrap system "$plist_path"
  launchctl kickstart -k "system/${label}" >/dev/null 2>&1 || true
  launchctl print "system/${label}" >/dev/null
  log "bootstrapped system/${label}"
}

require_root
require_command plutil
require_command launchctl

[[ -d "${SERVICE_ROOT}/src/joelclaw" ]] || fail "service checkout missing: ${SERVICE_ROOT}/src/joelclaw"
[[ -f "${SERVICE_ROOT}/src/joelclaw/infra/central/.env" ]] || fail "service env missing: ${SERVICE_ROOT}/src/joelclaw/infra/central/.env"
mkdir -p "${SERVICE_ROOT}/logs" "$CENTRAL_LOG_DIR"
chown "${SERVICE_USER}:${SERVICE_GROUP}" "${SERVICE_ROOT}/logs" "$CENTRAL_LOG_DIR"
chmod 750 "${SERVICE_ROOT}/logs" "$CENTRAL_LOG_DIR"

for label in "${LABELS[@]}"; do
  install_one "$label"
done

if [[ "$BOOTSTRAP" == "1" ]]; then
  for label in "${LABELS[@]}"; do
    bootstrap_one "$label"
  done
else
  for label in "${LABELS[@]}"; do
    disable_one "$label"
  done
  log "launchd plists installed and disabled; pass --bootstrap during Gate 4 to enable/start shadow runtime"
fi

log "central launchd install complete"
