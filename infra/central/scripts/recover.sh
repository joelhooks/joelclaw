#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

MODE="all"
PASSES="${CENTRAL_RECOVERY_PASSES:-3}"
SLEEP_SECONDS="${CENTRAL_RECOVERY_SLEEP_SECONDS:-10}"
COMPOSE_TIMEOUT_SECONDS="${CENTRAL_RECOVERY_COMPOSE_TIMEOUT_SECONDS:-120}"
DOCKER_VERSION_TIMEOUT_SECONDS="${CENTRAL_RECOVERY_DOCKER_VERSION_TIMEOUT_SECONDS:-20}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RECEIPT="${CENTRAL_LOG_DIR}/recovery-${STAMP}.log"
SERVICE_PATH="/opt/homebrew/bin:/Users/${SERVICE_USER}/.docker/bin:/Users/${SERVICE_USER}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

usage() {
  cat <<'USAGE'
Usage: recover.sh [--all|--redis-only] [--passes N]

Recover the Flagg Central shadow Compose services through the service user.
Writes a receipt under /Users/Shared/joelclaw/logs/central/ and only exits 0
after consecutive green health passes.

Run as root with sudo, or directly as the joelclaw service user.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      MODE="all"
      shift
      ;;
    --redis-only)
      MODE="redis-only"
      shift
      ;;
    --passes)
      PASSES="${2:-}"
      [[ -n "${PASSES}" ]] || fail "--passes requires a number"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if ! [[ "${PASSES}" =~ ^[0-9]+$ ]] || [[ "${PASSES}" -lt 1 ]]; then
  fail "--passes must be a positive integer"
fi

require_command timeout
ensure_service_dirs
mkdir -p "${CENTRAL_LOG_DIR}"
exec > >(tee -a "${RECEIPT}") 2>&1

run_as_service_user() {
  if [[ "$(id -un)" == "${SERVICE_USER}" ]]; then
    env \
      HOME="${SERVICE_HOME}" \
      PATH="${SERVICE_PATH}" \
      DOCKER_HOST="unix://${COLIMA_DOCKER_SOCKET}" \
      ENV_FILE="${ENV_FILE}" \
      "$@"
    return
  fi

  if [[ "${EUID}" -ne 0 ]]; then
    fail "run with sudo or as ${SERVICE_USER}"
  fi

  sudo -u "${SERVICE_USER}" -H env \
    HOME="${SERVICE_HOME}" \
    PATH="${SERVICE_PATH}" \
    DOCKER_HOST="unix://${COLIMA_DOCKER_SOCKET}" \
    ENV_FILE="${ENV_FILE}" \
    "$@"
}

service_compose() {
  if run_as_service_user timeout "${DOCKER_VERSION_TIMEOUT_SECONDS}" docker compose version >/dev/null 2>&1; then
    run_as_service_user timeout "${COMPOSE_TIMEOUT_SECONDS}" docker compose \
      --project-name "${COMPOSE_PROJECT_NAME}" \
      --env-file "${ENV_FILE}" \
      --file "${COMPOSE_FILE}" \
      "$@"
  else
    run_as_service_user timeout "${COMPOSE_TIMEOUT_SECONDS}" docker-compose \
      --project-name "${COMPOSE_PROJECT_NAME}" \
      --env-file "${ENV_FILE}" \
      --file "${COMPOSE_FILE}" \
      "$@"
  fi
}

probe_tcp() {
  local host="$1"
  local port="$2"
  nc -z -w 3 "${host}" "${port}"
}

probe_http() {
  local url="$1"
  curl -fsS --max-time 5 "${url}" >/dev/null
}

probe_redis() {
  local out
  out="$( { printf '*1\r\n$4\r\nPING\r\n'; sleep 0.1; } | nc -w 5 "${CENTRAL_BIND_ADDR}" 6379 2>/dev/null || true )"
  grep -q PONG <<<"${out}"
}

health_once() {
  local status=0
  probe_redis && log "ok redis ping" || { log "fail redis ping"; status=1; }
  probe_http "http://${CENTRAL_BIND_ADDR}:8108/health" && log "ok typesense /health" || { log "fail typesense /health"; status=1; }
  probe_http "http://${CENTRAL_BIND_ADDR}:8288/health" && log "ok inngest /health" || { log "fail inngest /health"; status=1; }
  probe_tcp "${CENTRAL_BIND_ADDR}" 8080 && log "ok restate ingress tcp" || { log "fail restate ingress tcp"; status=1; }
  probe_tcp "${CENTRAL_BIND_ADDR}" 9070 && log "ok restate admin tcp" || { log "fail restate admin tcp"; status=1; }
  probe_http "http://${CENTRAL_BIND_ADDR}:9000/minio/health/ready" && log "ok minio ready" || { log "fail minio ready"; status=1; }
  return "${status}"
}

log "Flagg Central recovery receipt: ${RECEIPT}"
log "mode=${MODE} passes=${PASSES} sleep=${SLEEP_SECONDS}s compose_timeout=${COMPOSE_TIMEOUT_SECONDS}s"
log "service_user=${SERVICE_USER} compose_project=${COMPOSE_PROJECT_NAME} bind=${CENTRAL_BIND_ADDR}"

log "preflight: launchd state"
for label in \
  com.joelclaw.central.colima \
  com.joelclaw.central.compose \
  com.joelclaw.central.health; do
  printf '### %s\n' "${label}"
  launchctl print "system/${label}" 2>&1 | grep -E 'state =|pid =|runs =|last exit code' || true
done

log "preflight: compose ps"
service_compose ps || true

log "preflight: current probes"
health_once || true

case "${MODE}" in
  redis-only)
    log "restart: redis"
    service_compose restart redis
    ;;
  all)
    log "restart: redis typesense inngest minio restate"
    service_compose restart redis typesense inngest minio restate
    ;;
  *)
    fail "unsupported mode: ${MODE}"
    ;;
esac

log "wait for services"
sleep "${SLEEP_SECONDS}"

log "post-restart compose ps"
service_compose ps || true

log "verification: require ${PASSES} consecutive green pass(es)"
for ((i = 1; i <= PASSES; i++)); do
  log "verification pass ${i}/${PASSES}"
  if ! health_once; then
    log "recovery failed on pass ${i}; inspect ${RECEIPT} and consider restarting the Colima profile"
    exit 2
  fi
  sleep "${SLEEP_SECONDS}"
done

log "PASS: Flagg Central services recovered for ${PASSES} consecutive pass(es)"
