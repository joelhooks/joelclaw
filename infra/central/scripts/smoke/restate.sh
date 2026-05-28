#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_smoke_command curl
require_smoke_command nc

smoke_log "checking Restate ingress TCP"
nc -z -w 5 "$CENTRAL_BIND_ADDR" 8080

smoke_log "checking Restate admin TCP"
nc -z -w 5 "$CENTRAL_BIND_ADDR" 9070

smoke_log "checking Restate metrics TCP"
nc -z -w 5 "$CENTRAL_BIND_ADDR" 9071

if curl -fsS --max-time 5 "http://${CENTRAL_BIND_ADDR}:9070/health" >/dev/null 2>&1; then
  smoke_log "admin /health ok"
elif curl -fsS --max-time 5 "http://${CENTRAL_BIND_ADDR}:9070" >/dev/null 2>&1; then
  smoke_log "admin root endpoint ok"
else
  smoke_log "admin HTTP probe unavailable; TCP checks passed"
fi

smoke_log "ok restate ports reachable"
