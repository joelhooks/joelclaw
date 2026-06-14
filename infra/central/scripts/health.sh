#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

status=0
CENTRAL_AUTO_RECOVER="${CENTRAL_AUTO_RECOVER:-1}"
CENTRAL_AUTO_RECOVER_AFTER_FAILURES="${CENTRAL_AUTO_RECOVER_AFTER_FAILURES:-3}"
CENTRAL_AUTO_RECOVER_COOLDOWN_SECONDS="${CENTRAL_AUTO_RECOVER_COOLDOWN_SECONDS:-900}"
CENTRAL_AUTO_RECOVER_PASSES="${CENTRAL_AUTO_RECOVER_PASSES:-2}"
CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS="${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS:-10}"
CENTRAL_HEALTH_FAILURE_FILE="${CENTRAL_HEALTH_FAILURE_FILE:-${CENTRAL_LOG_DIR}/health-consecutive-failures}"
CENTRAL_HEALTH_LAST_RECOVERY_FILE="${CENTRAL_HEALTH_LAST_RECOVERY_FILE:-${CENTRAL_LOG_DIR}/health-last-recovery-epoch}"
CENTRAL_HEALTH_RECOVERY_LOCK_DIR="${CENTRAL_HEALTH_RECOVERY_LOCK_DIR:-${CENTRAL_LOG_DIR}/health-recovery.lock}"

if ! [[ "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]] || [[ "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" -lt 1 || "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" -gt 30 ]]; then
  CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS=10
fi

read_number_file() {
  local file="$1"
  local fallback="$2"
  local value="${fallback}"

  if [[ -r "${file}" ]]; then
    value="$(tr -dc '0-9' <"${file}" | head -c 20)"
  fi

  if [[ -z "${value}" ]]; then
    value="${fallback}"
  fi

  printf '%s' "${value}"
}

write_number_file() {
  local file="$1"
  local value="$2"
  mkdir -p "$(dirname "${file}")"
  printf '%s\n' "${value}" >"${file}"
}

probe() {
  local label="$1"
  shift
  if "$@" >/tmp/central-health.$$ 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'fail %s\n' "$label"
    while IFS= read -r line; do
      printf '     %s\n' "$line"
    done < /tmp/central-health.$$
    status=1
  fi
  rm -f /tmp/central-health.$$
}

http_ok() {
  local url="$1"
  timeout "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" curl -fsS --connect-timeout 3 --max-time 5 --noproxy '*' "$url" >/dev/null
}

tcp_ok() {
  local host="$1"
  local port="$2"
  timeout "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" nc -z -w 5 "$host" "$port"
}

redis_ok() {
  local out
  out="$(timeout "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" bash -c '{ printf "*1\r\n$4\r\nPING\r\n"; sleep 0.1; } | nc -w 5 "$1" 6379' _ "$CENTRAL_BIND_ADDR" 2>/dev/null || true)"
  grep -q PONG <<<"$out"
}

maybe_recover() {
  local failures="$1"
  local now
  local last_recovery
  local age

  if [[ "${CENTRAL_AUTO_RECOVER}" != "1" ]]; then
    log "health degraded; auto recovery disabled (failures=${failures})"
    return 1
  fi

  if ! [[ "${CENTRAL_AUTO_RECOVER_AFTER_FAILURES}" =~ ^[0-9]+$ ]] || [[ "${CENTRAL_AUTO_RECOVER_AFTER_FAILURES}" -lt 1 ]]; then
    warn "invalid CENTRAL_AUTO_RECOVER_AFTER_FAILURES=${CENTRAL_AUTO_RECOVER_AFTER_FAILURES}; skipping recovery"
    return 1
  fi

  if [[ "${failures}" -lt "${CENTRAL_AUTO_RECOVER_AFTER_FAILURES}" ]]; then
    log "health degraded; waiting for threshold (${failures}/${CENTRAL_AUTO_RECOVER_AFTER_FAILURES})"
    return 1
  fi

  now="$(date +%s)"
  last_recovery="$(read_number_file "${CENTRAL_HEALTH_LAST_RECOVERY_FILE}" 0)"
  age=$((now - last_recovery))

  if [[ "${age}" -lt "${CENTRAL_AUTO_RECOVER_COOLDOWN_SECONDS}" ]]; then
    log "health degraded; recovery cooldown active (${age}/${CENTRAL_AUTO_RECOVER_COOLDOWN_SECONDS}s)"
    return 1
  fi

  if ! mkdir "${CENTRAL_HEALTH_RECOVERY_LOCK_DIR}" 2>/dev/null; then
    log "health degraded; recovery already running (${CENTRAL_HEALTH_RECOVERY_LOCK_DIR})"
    return 1
  fi

  trap 'rmdir "${CENTRAL_HEALTH_RECOVERY_LOCK_DIR}" 2>/dev/null || true' RETURN
  write_number_file "${CENTRAL_HEALTH_LAST_RECOVERY_FILE}" "${now}"

  log "health degraded for ${failures} consecutive pass(es); running bounded recovery"
  if "${SCRIPT_DIR}/recover.sh" --all --passes "${CENTRAL_AUTO_RECOVER_PASSES}"; then
    write_number_file "${CENTRAL_HEALTH_FAILURE_FILE}" 0
    log "auto recovery succeeded"
    return 0
  fi

  log "auto recovery failed"
  return 1
}

require_command curl
require_command nc
require_command timeout

printf 'Flagg Central shadow health\n'
if [[ "${CENTRAL_REQUIRE_NAS}" == "1" ]]; then
  probe 'nas mounts verified' "${SCRIPT_DIR}/verify-nas.sh"
fi
probe 'redis ping' redis_ok
probe 'typesense /health' http_ok "http://${CENTRAL_BIND_ADDR}:8108/health"
probe 'inngest /health' http_ok "http://${CENTRAL_BIND_ADDR}:8288/health"
probe 'restate ingress tcp' tcp_ok "$CENTRAL_BIND_ADDR" 8080
probe 'restate admin tcp' tcp_ok "$CENTRAL_BIND_ADDR" 9070
probe 'minio ready' http_ok "http://${CENTRAL_BIND_ADDR}:9000/minio/health/ready"

if [[ "${status}" == "0" ]]; then
  write_number_file "${CENTRAL_HEALTH_FAILURE_FILE}" 0
  exit 0
fi

failures="$(read_number_file "${CENTRAL_HEALTH_FAILURE_FILE}" 0)"
failures=$((failures + 1))
write_number_file "${CENTRAL_HEALTH_FAILURE_FILE}" "${failures}"

if maybe_recover "${failures}"; then
  exit 0
fi

exit "${status}"
