#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

status=0

check() {
  local label="$1"
  shift
  if "$@" >/tmp/central-preflight-check.$$ 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'fail %s\n' "$label"
    while IFS= read -r line; do
      printf '     %s\n' "$line"
    done < /tmp/central-preflight-check.$$
    status=1
  fi
  rm -f /tmp/central-preflight-check.$$
}

check_warn() {
  local label="$1"
  shift
  if "$@" >/tmp/central-preflight-check.$$ 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'warn %s\n' "$label"
    while IFS= read -r line; do
      printf '     %s\n' "$line"
    done < /tmp/central-preflight-check.$$
  fi
  rm -f /tmp/central-preflight-check.$$
}

service_user_exists() {
  id "$SERVICE_USER"
}

service_user_not_admin() {
  dsmemberutil checkmembership -U "$SERVICE_USER" -G admin | grep -q 'not a member'
}

separate_admin_exists() {
  dscacheutil -q group -a name admin \
    | awk -F: '/users:/ {print $2}' \
    | tr ' ' '\n' \
    | awk 'NF' \
    | grep -Ev '^(root|_mbsetupuser|joel)$' \
    | grep -q .
}

service_root_owned() {
  [[ -d "$SERVICE_ROOT" ]] || return 1
  local owner
  owner="$(stat -f '%Su:%Sg' "$SERVICE_ROOT")"
  [[ "$owner" == "${SERVICE_USER}:${SERVICE_GROUP}" ]]
}

env_file_exists() {
  [[ -f "$ENV_FILE" ]]
}

env_file_has_no_placeholders() {
  ! grep -q 'replace-with-' "$ENV_FILE"
}

docker_reachable() {
  docker info >/dev/null
}

pi_installed() {
  command -v pi >/dev/null
}

codex_installed() {
  command -v codex >/dev/null
}

central_launchdaemon_plists_installed() {
  local label
  for label in \
    com.joelclaw.central.colima \
    com.joelclaw.central.compose \
    com.joelclaw.central.health; do
    [[ -f "/Library/LaunchDaemons/${label}.plist" ]] || return 1
  done
}

system_tailscaled_loaded() {
  launchctl print system/com.tailscale.tailscaled >/dev/null
}

system_tailscaled_healthy() {
  "${SCRIPT_DIR}/verify-system-tailscaled.sh" >/dev/null
}

compose_config_valid() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" --file "$COMPOSE_FILE" config --quiet
}

printf 'Flagg Central preflight\n'
printf 'repo=%s\n' "$REPO_ROOT"
printf 'service_root=%s\n' "$SERVICE_ROOT"
printf '\n'

check 'service user exists' service_user_exists
check 'service user is not admin' service_user_not_admin
check 'separate non-Joel admin exists' separate_admin_exists
check 'service root owned by service user' service_root_owned
check_warn 'env file exists' env_file_exists

if [[ -f "$ENV_FILE" ]]; then
  load_env_if_present
  check_warn 'env placeholders replaced' env_file_has_no_placeholders
  printf 'info typesense_api_key=%s\n' "$(redact_value "${TYPESENSE_API_KEY:-}")"
  printf 'info minio_root_user=%s\n' "$(redact_value "${MINIO_ROOT_USER:-}")"
fi

check_warn 'system tailscaled LaunchDaemon loaded' system_tailscaled_loaded
if launchctl print system/com.tailscale.tailscaled >/dev/null 2>&1; then
  check_warn 'system tailscaled healthy' system_tailscaled_healthy
fi
check_warn 'colima installed' have colima
check_warn 'docker installed' have docker
check_warn 'pi installed' pi_installed
check_warn 'codex installed' codex_installed
check_warn 'central LaunchDaemon plists installed' central_launchdaemon_plists_installed
if have docker; then
  check_warn 'docker daemon reachable' docker_reachable
fi
if have docker && [[ -f "$ENV_FILE" ]]; then
  check_warn 'compose config renders' compose_config_valid
fi

exit "$status"
