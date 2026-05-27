#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

TAIL_LINES="${TAIL_LINES:-120}"
SERVICE_REPO="${SERVICE_ROOT}/src/joelclaw"
SERVICE_ENV_FILE="${SERVICE_REPO}/infra/central/.env"
SERVICE_COMPOSE_FILE="${SERVICE_REPO}/infra/central/compose.yaml"
SERVICE_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DOCKER_SOCK="${COLIMA_DOCKER_SOCKET}"

section() {
  printf '\n-- %s --\n' "$1"
}

run_or_true() {
  "$@" 2>&1 || true
}

service_run() {
  local env_args=(
    "HOME=${SERVICE_HOME}"
    "PATH=${SERVICE_PATH}"
  )
  if [[ -S "$DOCKER_SOCK" ]]; then
    env_args+=("DOCKER_HOST=unix://${DOCKER_SOCK}")
  fi
  sudo -u "$SERVICE_USER" env "${env_args[@]}" "$@" 2>&1 || true
}

section "identity"
printf 'user=%s\n' "$(id -un)"
printf 'console_user=%s\n' "$(stat -f '%Su' /dev/console 2>/dev/null || true)"
printf 'service_user=%s\n' "$SERVICE_USER"
printf 'service_home=%s\n' "$SERVICE_HOME"
printf 'service_root=%s\n' "$SERVICE_ROOT"
printf 'colima_profile=%s\n' "$COLIMA_PROFILE"
printf 'docker_sock=%s\n' "$DOCKER_SOCK"
printf 'docker_sock_present=%s\n' "$([[ -S "$DOCKER_SOCK" ]] && echo yes || echo no)"
printf 'service_env_file=%s\n' "$SERVICE_ENV_FILE"
printf 'service_compose_file=%s\n' "$SERVICE_COMPOSE_FILE"

section "launchd"
for label in \
  com.joelclaw.central.colima \
  com.joelclaw.central.compose \
  com.joelclaw.central.health; do
  printf '### %s\n' "$label"
  run_or_true launchctl print "system/${label}" \
    | grep -E 'state =|pid =|last exit code|runs =|program =|path =|stdout path|stderr path' \
    || true
done

section "disabled state"
run_or_true launchctl print-disabled system \
  | grep -E 'com\.joelclaw\.central\.(colima|compose|health)' \
  || true

section "service paths"
run_or_true ls -ld \
  "$SERVICE_ROOT" \
  "${SERVICE_ROOT}/src/joelclaw" \
  "$CENTRAL_LOG_DIR" \
  "${SERVICE_ROOT}/services" \
  "$SERVICE_HOME" \
  "${SERVICE_HOME}/.colima" \
  "${SERVICE_HOME}/.docker"

section "launchd logs"
if [[ -d "$CENTRAL_LOG_DIR" ]]; then
  find "$CENTRAL_LOG_DIR" -maxdepth 1 -type f -name '*.log' -print | sort | while IFS= read -r file; do
    printf '### %s\n' "$file"
    tail -n "$TAIL_LINES" "$file" 2>&1 || true
  done
else
  printf 'missing log dir: %s\n' "$CENTRAL_LOG_DIR"
fi

section "colima status as service user"
service_run colima status --profile "$COLIMA_PROFILE"

section "docker context as service user"
service_run docker context ls

section "docker ps as service user"
service_run docker ps -a

section "compose ps as service user"
service_run docker-compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --env-file "$SERVICE_ENV_FILE" \
  --file "$SERVICE_COMPOSE_FILE" \
  ps -a

section "ports"
for port in 6379 8108 8288 8289 8080 9070 9071 9000 9001; do
  if nc -z -w 2 "$CENTRAL_BIND_ADDR" "$port" >/dev/null 2>&1; then
    printf 'open %s\n' "$port"
  else
    printf 'closed %s\n' "$port"
  fi
done

section "http probes"
for url in \
  "http://${CENTRAL_BIND_ADDR}:8108/health" \
  "http://${CENTRAL_BIND_ADDR}:8288/health" \
  "http://${CENTRAL_BIND_ADDR}:9000/minio/health/ready"; do
  printf '### %s\n' "$url"
  curl -fsS --max-time 5 "$url" 2>&1 || true
  printf '\n'
done

section "container logs"
for service in redis typesense inngest restate minio; do
  printf '### %s\n' "$service"
  service_run docker logs --tail "$TAIL_LINES" "${COMPOSE_PROJECT_NAME}-${service}-1"
done

section "central health"
service_run env ENV_FILE="$SERVICE_ENV_FILE" "$SERVICE_REPO/infra/central/scripts/health.sh"
