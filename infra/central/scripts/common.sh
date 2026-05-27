#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CENTRAL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CENTRAL_DIR}/../.." && pwd)"

ENV_FILE="${ENV_FILE:-${CENTRAL_DIR}/.env}"
ENV_EXAMPLE="${CENTRAL_DIR}/.env.example"
COMPOSE_FILE="${COMPOSE_FILE:-${CENTRAL_DIR}/compose.yaml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-joelclaw-central-shadow}"
SERVICE_ROOT="${SERVICE_ROOT:-/Users/Shared/joelclaw}"
SERVICE_USER="${SERVICE_USER:-joelclaw}"
SERVICE_GROUP="${SERVICE_GROUP:-staff}"
CENTRAL_BACKUP_DIR="${CENTRAL_BACKUP_DIR:-${SERVICE_ROOT}/backups/central}"
CENTRAL_LOG_DIR="${CENTRAL_LOG_DIR:-${SERVICE_ROOT}/logs/central}"
COLIMA_PROFILE="${COLIMA_PROFILE:-joelclaw-central}"
CENTRAL_BIND_ADDR="${CENTRAL_BIND_ADDR:-127.0.0.1}"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'warn: %s\n' "$*" >&2
}

have() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  have "$1" || fail "missing command: $1"
}

load_env_if_present() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

require_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    fail "missing ${ENV_FILE}; copy ${ENV_EXAMPLE} to .env and replace placeholders"
  fi
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose \
      --project-name "$COMPOSE_PROJECT_NAME" \
      --env-file "$ENV_FILE" \
      --file "$COMPOSE_FILE" \
      "$@"
  else
    require_command docker-compose
    docker-compose \
      --project-name "$COMPOSE_PROJECT_NAME" \
      --env-file "$ENV_FILE" \
      --file "$COMPOSE_FILE" \
      "$@"
  fi
}

ensure_service_dirs() {
  mkdir -p \
    "${SERVICE_ROOT}/services/redis" \
    "${SERVICE_ROOT}/services/typesense" \
    "${SERVICE_ROOT}/services/inngest" \
    "${SERVICE_ROOT}/services/restate" \
    "${SERVICE_ROOT}/services/minio" \
    "$CENTRAL_BACKUP_DIR" \
    "$CENTRAL_LOG_DIR"
}

redact_value() {
  local value="$1"
  if [[ -z "$value" ]]; then
    printf '<unset>'
  elif [[ "$value" == replace-with-* ]]; then
    printf '<placeholder>'
  else
    printf '<set>'
  fi
}
