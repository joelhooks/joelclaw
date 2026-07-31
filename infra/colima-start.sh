#!/bin/bash
set -euo pipefail

export HOME="/Users/joel"
export PATH="/opt/homebrew/bin:/Users/joel/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

COLIMA_BIN="${COLIMA_BIN:-/opt/homebrew/bin/colima}"
CHECK_INTERVAL_SECONDS="${COLIMA_CHECK_INTERVAL_SECONDS:-30}"
PROFILE_CONFIG="$HOME/.colima/default/colima.yaml"

log() {
  printf '[colima-supervisor] %s\n' "$*"
}

[ -x "$COLIMA_BIN" ] || {
  log "colima is missing or not executable: $COLIMA_BIN"
  exit 78
}
[ -f "$PROFILE_CONFIG" ] || {
  log "saved default profile is missing: $PROFILE_CONFIG"
  exit 78
}

log "supervising Joel's saved default profile"
while true; do
  if "$COLIMA_BIN" status --json >/dev/null 2>&1; then
    sleep "$CHECK_INTERVAL_SECONDS"
    continue
  fi

  log "default profile is down; starting it from saved config"
  if "$COLIMA_BIN" start; then
    log "default profile started"
  else
    log "default profile start failed; retrying in ${CHECK_INTERVAL_SECONDS}s"
  fi
  sleep "$CHECK_INTERVAL_SECONDS"
done
