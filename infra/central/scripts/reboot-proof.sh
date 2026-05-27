#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

status=0
BOOT_EPOCH="$(sysctl -n kern.boottime | awk -F'[=,]' '{gsub(/ /, "", $2); print $2}')"
BOOT_ISO="$(date -u -r "$BOOT_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"

probe() {
  local label="$1"
  shift
  if "$@" >/tmp/central-reboot-proof.$$ 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'fail %s\n' "$label"
    while IFS= read -r line; do
      printf '     %s\n' "$line"
    done < /tmp/central-reboot-proof.$$
    status=1
  fi
  rm -f /tmp/central-reboot-proof.$$
}

console_is_loginwindow() {
  local console_user
  console_user="$(stat -f '%Su' /dev/console)"
  [[ "$console_user" == "root" ]]
}

launchd_label_loaded() {
  local label="$1"
  local out="/tmp/launchd-${label}.$$"
  if ! launchctl print "system/${label}" >"$out" 2>&1; then
    cat "$out"
    rm -f "$out"
    return 1
  fi
  if grep -Eq 'last exit code = [1-9][0-9]*' "$out"; then
    cat "$out"
    rm -f "$out"
    return 1
  fi
  rm -f "$out"
}

file_written_after_boot() {
  local path="$1"
  [[ -f "$path" ]] || return 1
  local mtime
  mtime="$(stat -f '%m' "$path")"
  (( mtime >= BOOT_EPOCH ))
}

docker_reachable() {
  docker info >/dev/null
}

require_env_file
load_env_if_present
require_command docker
require_command launchctl
require_command sysctl
require_command stat

printf 'Flagg Central hard-reboot proof\n'
printf 'boot=%s\n' "$BOOT_ISO"
printf 'console_user=%s\n' "$(stat -f '%Su' /dev/console)"
printf 'service_root=%s\n' "$SERVICE_ROOT"
printf '\n'

probe 'no GUI console login active' console_is_loginwindow
probe 'launchd colima label loaded' launchd_label_loaded com.joelclaw.central.colima
probe 'launchd compose label loaded' launchd_label_loaded com.joelclaw.central.compose
probe 'launchd health label loaded' launchd_label_loaded com.joelclaw.central.health
probe 'colima launchd log written after boot' file_written_after_boot "${CENTRAL_LOG_DIR}/colima.out.log"
probe 'compose launchd log written after boot' file_written_after_boot "${CENTRAL_LOG_DIR}/compose.out.log"
probe 'docker daemon reachable' docker_reachable
probe 'central service health passes' "${SCRIPT_DIR}/health.sh"

if [[ "$status" -eq 0 ]]; then
  printf '\nPASS: Central recovered after hard reboot with no GUI login.\n'
else
  printf '\nFAIL: hard-reboot/no-login recovery is not proven. Not eligible for cutover.\n' >&2
fi

exit "$status"
