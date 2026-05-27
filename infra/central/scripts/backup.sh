#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="${CENTRAL_BACKUP_DIR}/central-shadow-${STAMP}.tar.gz"

mkdir -p "$CENTRAL_BACKUP_DIR"

log "creating filesystem snapshot archive: ${BACKUP_PATH}"
log "note: for production cutover, add service-native Redis/Typesense export steps before relying on this backup"
log "note: Restate uses Docker volume ${CENTRAL_RESTATE_VOLUME}; this filesystem snapshot excludes that volume"

tar -czf "$BACKUP_PATH" \
  -C "$SERVICE_ROOT" \
  services/redis \
  services/typesense \
  services/inngest \
  services/minio

chmod 600 "$BACKUP_PATH"
log "backup=${BACKUP_PATH}"
