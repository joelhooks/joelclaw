#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

printf 'Flagg Central shadow status\n'
printf 'service_root=%s\n' "$SERVICE_ROOT"
printf 'compose_file=%s\n' "$COMPOSE_FILE"
printf 'env_file=%s\n' "$ENV_FILE"
printf 'project=%s\n' "$COMPOSE_PROJECT_NAME"
printf 'bind_addr=%s\n' "$CENTRAL_BIND_ADDR"
printf '\n'

if have colima; then
  printf 'Colima profile %s:\n' "$COLIMA_PROFILE"
  colima status --profile "$COLIMA_PROFILE" || true
else
  printf 'Colima: missing\n'
fi

printf '\nDocker compose:\n'
if have docker && [[ -f "$ENV_FILE" ]]; then
  compose ps || true
elif ! have docker; then
  printf 'docker missing\n'
else
  printf 'env file missing: %s\n' "$ENV_FILE"
fi
