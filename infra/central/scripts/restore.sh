#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<USAGE
Usage: $0 <backup-tar.gz>

Restores a Flagg Central shadow filesystem snapshot into ${SERVICE_ROOT}/services.
This is destructive to shadow service data. It is not a Panda cutover/rollback tool.
USAGE
}

[[ $# -eq 1 ]] || { usage >&2; exit 64; }
BACKUP_PATH="$1"
[[ -f "$BACKUP_PATH" ]] || fail "backup not found: $BACKUP_PATH"

log "stopping compose stack before restore"
if [[ -f "$ENV_FILE" ]] && have docker; then
  load_env_if_present
  compose down || true
fi

log "restoring ${BACKUP_PATH} into ${SERVICE_ROOT}"
tar -xzf "$BACKUP_PATH" -C "$SERVICE_ROOT"
log "restore complete; run ./infra/central/scripts/start.sh then health.sh"
