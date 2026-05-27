#!/usr/bin/env bash
set -euo pipefail

SERVICE_ROOT="${SERVICE_ROOT:-/Users/Shared/joelclaw}"
TAILSCALED_BIN="${TAILSCALED_BIN:-/opt/homebrew/bin/tailscaled}"
RESTORE_APP_FROM="${RESTORE_APP_FROM:-}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || fail "run with sudo: sudo $0"

log "uninstalling system tailscaled LaunchDaemon"
if [[ -x "$TAILSCALED_BIN" ]]; then
  "$TAILSCALED_BIN" uninstall-system-daemon || true
else
  launchctl bootout system /Library/LaunchDaemons/com.tailscale.tailscaled.plist >/dev/null 2>&1 || true
  rm -f /Library/LaunchDaemons/com.tailscale.tailscaled.plist
fi

if [[ -z "$RESTORE_APP_FROM" ]]; then
  RESTORE_APP_FROM="$(find "${SERVICE_ROOT}/backups" -maxdepth 3 -type d -name Tailscale.app 2>/dev/null | sort | tail -1 || true)"
fi

if [[ -n "$RESTORE_APP_FROM" && -d "$RESTORE_APP_FROM" ]]; then
  if [[ -d /Applications/Tailscale.app ]]; then
    fail "/Applications/Tailscale.app already exists; not overwriting"
  fi
  log "restoring GUI app from ${RESTORE_APP_FROM}"
  ditto "$RESTORE_APP_FROM" /Applications/Tailscale.app
  open /Applications/Tailscale.app || true
else
  log "no GUI app backup found; reinstall Tailscale Standalone manually if needed"
fi

log "rollback complete"
