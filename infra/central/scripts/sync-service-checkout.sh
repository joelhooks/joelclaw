#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

SOURCE_REPO="${SOURCE_REPO:-${REPO_ROOT}}"
TARGET_REPO="${TARGET_REPO:-${SERVICE_ROOT}/src/joelclaw}"

require_root() {
  [[ "$(id -u)" == "0" ]] || fail "run with sudo: sudo $0"
}

require_root
require_command rsync

[[ -d "$SOURCE_REPO" ]] || fail "source repo missing: ${SOURCE_REPO}"
[[ -f "${SOURCE_REPO}/infra/central/compose.yaml" ]] || fail "source repo does not look like joelclaw: ${SOURCE_REPO}"
# rsync --delete below removes anything absent from the source, including the
# service checkout's shadow .env. Refuse before the destructive step, not after:
# on 2026-07-09 the post-rsync check fired only after the live .env was deleted.
[[ -f "${SOURCE_REPO}/infra/central/.env" ]] || fail "source checkout missing infra/central/.env; run write-shadow-env.sh (or copy the existing shadow env into the source checkout) before syncing, or --delete will remove the service checkout's .env"

log "syncing service-owned checkout"
log "source=${SOURCE_REPO}"
log "target=${TARGET_REPO}"

mkdir -p "$SERVICE_ROOT" "${SERVICE_ROOT}/src" "$TARGET_REPO" "${SERVICE_ROOT}/logs" "$CENTRAL_LOG_DIR"
chown "${SERVICE_USER}:${SERVICE_GROUP}" "$SERVICE_ROOT" "${SERVICE_ROOT}/src" "${SERVICE_ROOT}/logs" "$CENTRAL_LOG_DIR"
chmod 711 "$SERVICE_ROOT"
chmod 755 "${SERVICE_ROOT}/src"
chmod 750 "${SERVICE_ROOT}/logs" "$CENTRAL_LOG_DIR"

rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.next/' \
  --exclude '.turbo/' \
  --exclude '.vercel/' \
  --exclude 'coverage/' \
  --exclude '*.log' \
  "${SOURCE_REPO}/" \
  "${TARGET_REPO}/"

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$TARGET_REPO"
find "$TARGET_REPO" -type d -exec chmod 755 {} +
find "$TARGET_REPO" -type f -exec chmod 644 {} +
find "$TARGET_REPO/infra/central/scripts" -type f -name '*.sh' -exec chmod 755 {} +

if [[ ! -f "${TARGET_REPO}/infra/central/.env" ]]; then
  fail "service checkout missing infra/central/.env; run write-shadow-env.sh in source checkout before syncing"
fi
chmod 600 "${TARGET_REPO}/infra/central/.env"
chown "${SERVICE_USER}:${SERVICE_GROUP}" "${TARGET_REPO}/infra/central/.env"

log "service checkout synced"
