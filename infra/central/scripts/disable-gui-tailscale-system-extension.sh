#!/usr/bin/env bash
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SERVICE_ROOT="${SERVICE_ROOT:-/Users/Shared/joelclaw}"
RECEIPT_DIR="${SERVICE_ROOT}/run"
RECEIPT="${RECEIPT_DIR}/tailscale-gui-system-extension-disable-${STAMP}.txt"
TEAM_ID="${TAILSCALE_GUI_TEAM_ID:-W5364U7YZB}"
BUNDLE_ID="${TAILSCALE_GUI_BUNDLE_ID:-io.tailscale.ipn.macsys.network-extension}"
PROCESS_PATTERN="${TAILSCALE_GUI_PROCESS_PATTERN:-io.tailscale.ipn.macsys.network-extension}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_root() {
  [[ "$(id -u)" == "0" ]] || fail "run with sudo: sudo $0"
}

extension_line() {
  systemextensionsctl list 2>/dev/null | grep "$BUNDLE_ID" || true
}

write_state() {
  local phase="$1"
  {
    echo "--- ${phase}: systemextensionsctl list ---"
    systemextensionsctl list 2>&1 || true
    echo
    echo "--- ${phase}: tailscale processes ---"
    ps aux | grep -i '[t]ailscale' || true
  } >> "$RECEIPT"
}

require_root
mkdir -p "$RECEIPT_DIR"
chmod 700 "$RECEIPT_DIR" 2>/dev/null || true
{
  echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "team_id=${TEAM_ID}"
  echo "bundle_id=${BUNDLE_ID}"
  echo "process_pattern=${PROCESS_PATTERN}"
  echo
} > "$RECEIPT"

write_state before

if [[ -n "$(extension_line)" ]]; then
  log "requesting GUI Tailscale system extension uninstall"
  set +e
  systemextensionsctl uninstall "$TEAM_ID" "$BUNDLE_ID" >>"$RECEIPT" 2>&1
  uninstall_status=$?
  set -e
  if [[ "$uninstall_status" -ne 0 ]]; then
    log "systemextensionsctl uninstall returned ${uninstall_status}; see receipt=${RECEIPT}"
  fi
else
  log "GUI Tailscale system extension not listed"
fi

log "stopping stale GUI Tailscale network extension process if present"
pkill -f "$PROCESS_PATTERN" >/dev/null 2>&1 || true
sleep 2

write_state after
chmod 600 "$RECEIPT"

if pgrep -f "$PROCESS_PATTERN" >/dev/null 2>&1; then
  log "GUI network extension process is still running"
  log "receipt=${RECEIPT}"
  fail "reboot Flagg, then run verify-system-tailscaled.sh before GUI login"
fi

if extension_line | grep -q 'activated enabled'; then
  log "extension is still activated/enabled but process is stopped"
  log "receipt=${RECEIPT}"
  fail "reboot Flagg to complete system extension removal, then verify before GUI login"
fi

log "GUI Tailscale system extension is not active"
log "receipt=${RECEIPT}"
