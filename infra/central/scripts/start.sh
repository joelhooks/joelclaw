#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env_file
load_env_if_present
ensure_service_dirs
configure_docker_host

wait_for_docker() {
  local attempts="${CENTRAL_DOCKER_WAIT_ATTEMPTS:-60}"
  local sleep_seconds="${CENTRAL_DOCKER_WAIT_SLEEP:-2}"

  for ((i = 1; i <= attempts; i++)); do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    log "waiting for docker daemon (${i}/${attempts})"
    sleep "$sleep_seconds"
  done

  fail "docker daemon did not become reachable"
}

wait_for_docker
if [[ "${CENTRAL_REQUIRE_NAS}" == "1" ]]; then
  log "CENTRAL_REQUIRE_NAS=1; verifying NAS mounts before compose start"
  "${SCRIPT_DIR}/verify-nas.sh"
fi
log "starting Flagg Central shadow compose stack"
compose up -d
log "started; run ./infra/central/scripts/health.sh"
