#!/usr/bin/env bash
set -euo pipefail

# Migrate Flagg from GUI/login-session Tailscale to the open-source system
# tailscaled LaunchDaemon. Run locally on Flagg. Running this over the very
# Tailscale link being replaced is how you summon the network weasel.

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SERVICE_ROOT="${SERVICE_ROOT:-/Users/Shared/joelclaw}"
RECEIPT_DIR="${SERVICE_ROOT}/run"
BACKUP_DIR="${SERVICE_ROOT}/backups/tailscale-gui-${STAMP}"
TAILSCALE_BIN="${TAILSCALE_BIN:-/opt/homebrew/bin/tailscale}"
TAILSCALED_BIN="${TAILSCALED_BIN:-/opt/homebrew/bin/tailscaled}"
TAILSCALE_HOSTNAME="${TAILSCALE_HOSTNAME:-flagg}"
TAILSCALE_OPERATOR="${TAILSCALE_OPERATOR:-joel}"
TAILSCALE_UP_FLAGS="${TAILSCALE_UP_FLAGS:---hostname=${TAILSCALE_HOSTNAME} --operator=${TAILSCALE_OPERATOR} --ssh}"
ALLOW_REMOTE_TAILSCALE_MIGRATION="${ALLOW_REMOTE_TAILSCALE_MIGRATION:-0}"
MOVE_GUI_APP="${MOVE_GUI_APP:-1}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_root() {
  [[ "$(id -u)" == "0" ]] || fail "run with sudo: sudo $0"
}

refuse_remote_default() {
  if [[ -n "${SSH_CONNECTION:-}" && "$ALLOW_REMOTE_TAILSCALE_MIGRATION" != "1" ]]; then
    fail "refusing to migrate Tailscale over SSH. Run locally on Flagg, or set ALLOW_REMOTE_TAILSCALE_MIGRATION=1 if you like cliff edges."
  fi
}

require_bins() {
  [[ -x "$TAILSCALE_BIN" ]] || fail "missing tailscale binary: $TAILSCALE_BIN"
  [[ -x "$TAILSCALED_BIN" ]] || fail "missing tailscaled binary: $TAILSCALED_BIN"
}

write_receipt_header() {
  mkdir -p "$RECEIPT_DIR" "$BACKUP_DIR"
  RECEIPT="${RECEIPT_DIR}/tailscale-system-migration-${STAMP}.txt"
  {
    echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "host=$(hostname)"
    echo "operator=${TAILSCALE_OPERATOR}"
    echo "hostname=${TAILSCALE_HOSTNAME}"
    echo "tailscale_bin=${TAILSCALE_BIN}"
    echo "tailscaled_bin=${TAILSCALED_BIN}"
    echo "backup_dir=${BACKUP_DIR}"
    echo "up_flags=${TAILSCALE_UP_FLAGS}"
    echo
    echo "--- before tailscale status ---"
    "$TAILSCALE_BIN" status || true
    echo
    echo "--- before processes ---"
    ps aux | grep -i '[t]ailscale' || true
  } > "$RECEIPT"
}

stop_gui_variant() {
  log "stopping GUI/login-session Tailscale variant"

  local console_user console_uid
  console_user="$(stat -f '%Su' /dev/console || true)"
  if [[ -n "$console_user" && "$console_user" != "root" ]]; then
    console_uid="$(id -u "$console_user" 2>/dev/null || true)"
    if [[ -n "$console_uid" ]]; then
      launchctl asuser "$console_uid" osascript -e 'tell application "Tailscale" to quit' >/dev/null 2>&1 || true
      launchctl bootout "gui/${console_uid}/io.tailscale.ipn.macsys.login-item-helper" >/dev/null 2>&1 || true
      launchctl disable "gui/${console_uid}/io.tailscale.ipn.macsys.login-item-helper" >/dev/null 2>&1 || true
    fi
  fi

  pkill -x Tailscale >/dev/null 2>&1 || true
  sleep 2

  if [[ "$MOVE_GUI_APP" == "1" && -d /Applications/Tailscale.app ]]; then
    log "moving /Applications/Tailscale.app out of /Applications"
    mv /Applications/Tailscale.app "${BACKUP_DIR}/Tailscale.app"
  fi
}

install_daemon() {
  log "installing system tailscaled LaunchDaemon"
  "$TAILSCALED_BIN" install-system-daemon
  sleep 2
  launchctl print system/com.tailscale.tailscaled >/dev/null
}

bring_up_tailnet() {
  log "running tailscale up for system daemon"
  log "if this prints an auth URL, open it locally and approve the new node"
  # shellcheck disable=SC2086
  "$TAILSCALE_BIN" up $TAILSCALE_UP_FLAGS
}

verify() {
  log "verifying system tailscaled"
  "$(cd "$(dirname "$0")" && pwd)/verify-system-tailscaled.sh"
}

write_receipt_footer() {
  {
    echo
    echo "--- after tailscale status ---"
    "$TAILSCALE_BIN" status || true
    echo
    echo "--- after processes ---"
    ps aux | grep -i '[t]ailscale' || true
    echo
    echo "--- launchd ---"
    launchctl print system/com.tailscale.tailscaled || true
  } >> "$RECEIPT"
  chmod 600 "$RECEIPT"
  log "receipt=${RECEIPT}"
}

main() {
  require_root
  refuse_remote_default
  require_bins
  write_receipt_header
  log "setting no-sleep server pmset profile"
  pmset -a sleep 0 disksleep 0 womp 1 tcpkeepalive 1 autorestart 1
  stop_gui_variant
  install_daemon
  bring_up_tailnet
  verify
  write_receipt_footer
  log "system tailscaled migration complete"
}

main "$@"
