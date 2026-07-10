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
SERVICE_HOME="${SERVICE_HOME:-/Users/${SERVICE_USER}}"
CENTRAL_BACKUP_DIR="${CENTRAL_BACKUP_DIR:-${SERVICE_ROOT}/backups/central}"
CENTRAL_LOG_DIR="${CENTRAL_LOG_DIR:-${SERVICE_ROOT}/logs/central}"
COLIMA_PROFILE="${COLIMA_PROFILE:-joelclaw-central}"
COLIMA_DOCKER_SOCKET="${COLIMA_DOCKER_SOCKET:-${SERVICE_HOME}/.colima/${COLIMA_PROFILE}/docker.sock}"
CENTRAL_RESTATE_VOLUME="${CENTRAL_RESTATE_VOLUME:-joelclaw-central-restate-data}"
CENTRAL_BIND_ADDR="${CENTRAL_BIND_ADDR:-127.0.0.1}"
CENTRAL_REQUIRE_NAS="${CENTRAL_REQUIRE_NAS:-0}"
NAS_HOST="${NAS_HOST:-three-body}"
NAS_IP="${NAS_IP:-192.168.1.163}"
NAS_EXPECTED_INTERFACE="${NAS_EXPECTED_INTERFACE:-en0}"
NAS_EXPECTED_MEDIA="${NAS_EXPECTED_MEDIA:-10Gbase-T}"
NAS_EXPECTED_MTU="${NAS_EXPECTED_MTU:-8192}"
NAS_NFS_OPTIONS="${NAS_NFS_OPTIONS:-rw,resvport,nfsvers=3,tcp,soft,intr,timeo=10,retrans=2,rsize=524288,wsize=524288,dsize=65536,readahead=128}"
# Use the LAN IP for persistent NFS mounts. On Flagg, `three-body` resolves
# through Tailscale/MagicDNS, which is useful for SSH/admin but wrong for
# shelf-local NAS data mounts scoped to 192.168.1.0/24 exports.
CENTRAL_NAS_NVME_EXPORT="${CENTRAL_NAS_NVME_EXPORT:-${NAS_IP}:/volume2/data}"
CENTRAL_NAS_NVME_MOUNT="${CENTRAL_NAS_NVME_MOUNT:-/Volumes/nas-nvme}"
CENTRAL_NAS_HDD_EXPORT="${CENTRAL_NAS_HDD_EXPORT:-${NAS_IP}:/volume1/joelclaw}"
CENTRAL_NAS_HDD_MOUNT="${CENTRAL_NAS_HDD_MOUNT:-/Volumes/three-body}"
# Direct 10GbE media path for transcription/editing workloads. Do not stage
# large media through SSH or local copies when this mount is healthy.
CENTRAL_NAS_MEDIA_EXPORT="${CENTRAL_NAS_MEDIA_EXPORT:-${NAS_IP}:/volume1/badass-media}"
CENTRAL_NAS_MEDIA_MOUNT="${CENTRAL_NAS_MEDIA_MOUNT:-/Volumes/badass-media}"
CENTRAL_MINIO_HOT_DATA="${CENTRAL_MINIO_HOT_DATA:-${CENTRAL_NAS_NVME_MOUNT}/s3}"
CENTRAL_MINIO_COLD_DATA="${CENTRAL_MINIO_COLD_DATA:-${CENTRAL_NAS_HDD_MOUNT}/s3}"

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
    if [[ ! -r "$ENV_FILE" ]]; then
      warn "env file exists but is not readable by $(id -un); using process env/defaults"
      return 0
    fi
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

configure_docker_host() {
  if [[ -z "${DOCKER_HOST:-}" && -S "$COLIMA_DOCKER_SOCKET" ]]; then
    export DOCKER_HOST="unix://${COLIMA_DOCKER_SOCKET}"
  fi
}

compose() {
  configure_docker_host
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
