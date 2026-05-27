#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

require_command colima

COLIMA_CPU="${COLIMA_CPU:-8}"
COLIMA_MEMORY="${COLIMA_MEMORY:-24}"
COLIMA_DISK="${COLIMA_DISK:-200}"

ensure_service_dirs

log "starting Colima profile ${COLIMA_PROFILE} for Flagg Central shadow runtime"
log "service root mount: ${SERVICE_ROOT}:w"

exec colima start \
  --profile "$COLIMA_PROFILE" \
  --vm-type vz \
  --mount-type virtiofs \
  --runtime docker \
  --cpus "$COLIMA_CPU" \
  --memory "$COLIMA_MEMORY" \
  --disk "$COLIMA_DISK" \
  --mount "${SERVICE_ROOT}:w"
