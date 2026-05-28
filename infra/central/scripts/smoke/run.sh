#!/usr/bin/env bash
set -euo pipefail

SMOKE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SMOKE_SCRIPT_DIR}/lib.sh"

mkdir -p "${CENTRAL_LOG_DIR}/smoke"
receipt="${CENTRAL_LOG_DIR}/smoke/phase-a-$(date -u +%Y%m%dT%H%M%SZ).log"

status=0
services=(redis typesense inngest restate minio)
if [[ "${CENTRAL_REQUIRE_NAS}" == "1" ]]; then
  services=(nas "${services[@]}")
fi

exec > >(tee "$receipt") 2>&1

log "Flagg Gate 5 Phase A smoke harness"
log "host=$(hostname) user=$(id -un) bind=${CENTRAL_BIND_ADDR}"
log "receipt=${receipt}"
log "mode=shadow-only; no Panda freeze; isolated temp writes only"

for service in "${services[@]}"; do
  script="${SMOKE_SCRIPT_DIR}/${service}.sh"
  printf '\n== %s ==\n' "$service"
  if "$script"; then
    printf 'ok   %s\n' "$service"
  else
    printf 'fail %s\n' "$service"
    status=1
  fi
done

printf '\n'
if [[ "$status" -eq 0 ]]; then
  log "PASS: Flagg Gate 5 Phase A shadow smoke passed"
else
  log "FAIL: Flagg Gate 5 Phase A shadow smoke failed"
fi

exit "$status"
