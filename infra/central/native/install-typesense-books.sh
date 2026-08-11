#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LABEL="com.joelclaw.typesense-books"
MAIN_CONFIG="${JOELCLAW_MAIN_TYPESENSE_CONFIG:-/Users/Shared/joelclaw/etc/typesense/typesense.ini}"
CONFIG_DIR="${HOME}/.config/joelclaw"
CONFIG="${CONFIG_DIR}/typesense-books.ini"
RUNTIME_ROOT="${HOME}/.joelclaw/typesense-books"
TARGET_SCRIPT="${HOME}/.joelclaw/scripts/typesense-books-start.sh"
TARGET_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
ENV_FILE="${HOME}/.config/system-bus.env"
BINARY="${TYPESENSE_BOOKS_BINARY:-/opt/homebrew/opt/typesense-server@30.2/bin/typesense-server}"
HEALTH_URL="http://127.0.0.1:8110/health"
TAILNET_HEALTH_URL="${TYPESENSE_BOOKS_TAILNET_HEALTH_URL:-http://joels-mac-studio.tail7af24.ts.net:8110/health}"
HEALTH_ATTEMPTS="${TYPESENSE_BOOKS_HEALTH_ATTEMPTS:-60}"
# Background session type + user domain: flagg runs headless (no gui/501).
DOMAIN="user/$(id -u)"

config_tmp=""
plist_tmp=""
backup_dir=""
mutated=0
committed=0
was_loaded=0
was_disabled=0

upsert_env_var() {
  file="$1"
  key="$2"
  value="$3"
  tmp="${file}.tmp.$$"
  [ -f "${file}" ] || : > "${file}"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      found = 1
      next
    }
    { print }
    END {
      if (!found) print key "=" value
    }
  ' "${file}" > "${tmp}"
  chmod 0600 "${tmp}"
  mv "${tmp}" "${file}"
}

backup_file() {
  source_file="$1"
  backup_name="$2"
  if [ -e "${source_file}" ]; then
    cp -p "${source_file}" "${backup_dir}/${backup_name}"
  else
    : > "${backup_dir}/${backup_name}.missing"
  fi
}

restore_file() {
  backup_name="$1"
  target_file="$2"
  if [ -f "${backup_dir}/${backup_name}.missing" ]; then
    rm -f "${target_file}"
  else
    cp -p "${backup_dir}/${backup_name}" "${target_file}"
  fi
}

wait_for_stop() {
  attempt=0
  while launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "${attempt}" -ge 20 ]; then
      return 1
    fi
    sleep 1
  done
}

service_is_running() {
  launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null |
    grep -Eq '^[[:space:]]*state = running$'
}

rollback() {
  set +e
  rollback_failed=0
  printf 'Install failed; restoring the previous %s files and service state.\n' "${LABEL}" >&2
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  wait_for_stop >/dev/null 2>&1 || rollback_failed=1
  restore_file config "${CONFIG}" || rollback_failed=1
  restore_file start-script "${TARGET_SCRIPT}" || rollback_failed=1
  restore_file plist "${TARGET_PLIST}" || rollback_failed=1
  restore_file env "${ENV_FILE}" || rollback_failed=1
  if [ "${was_loaded}" -eq 1 ]; then
    if [ -f "${TARGET_PLIST}" ]; then
      launchctl bootstrap "${DOMAIN}" "${TARGET_PLIST}" >/dev/null 2>&1 || rollback_failed=1
      launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || rollback_failed=1
    else
      rollback_failed=1
    fi
  fi
  if [ "${was_disabled}" -eq 1 ]; then
    launchctl disable "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || rollback_failed=1
    launchctl print-disabled "${DOMAIN}" 2>/dev/null |
      grep -F "\"${LABEL}\" => true" >/dev/null 2>&1 || rollback_failed=1
  fi
  return "${rollback_failed}"
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "${committed}" -eq 0 ] && [ "${mutated}" -eq 1 ]; then
    if ! rollback; then
      printf 'Rollback verification failed for %s. Manual repair is required.\n' "${LABEL}" >&2
      status=3
    fi
  fi
  [ -z "${config_tmp}" ] || rm -f "${config_tmp}"
  [ -z "${plist_tmp}" ] || rm -f "${plist_tmp}"
  [ -z "${backup_dir}" ] || rm -rf "${backup_dir}"
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for command_name in awk curl grep install launchctl plutil sed; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "${command_name}" >&2
    exit 2
  fi
done
if [ ! -x "${BINARY}" ]; then
  printf 'Typesense binary is missing: %s\n' "${BINARY}" >&2
  exit 2
fi
case "${HEALTH_ATTEMPTS}" in
  ''|*[!0-9]*)
    printf 'TYPESENSE_BOOKS_HEALTH_ATTEMPTS must be a positive integer.\n' >&2
    exit 2
    ;;
esac
if [ "${HEALTH_ATTEMPTS}" -lt 1 ]; then
  printf 'TYPESENSE_BOOKS_HEALTH_ATTEMPTS must be a positive integer.\n' >&2
  exit 2
fi

umask 077
mkdir -p "${CONFIG_DIR}" "${RUNTIME_ROOT}/data" "${RUNTIME_ROOT}/logs"
mkdir -p "$(dirname "${TARGET_SCRIPT}")" "$(dirname "${TARGET_PLIST}")"

api_key="${TYPESENSE_API_KEY:-}"
if [ -z "${api_key}" ] && [ -r "${MAIN_CONFIG}" ]; then
  api_key="$(
    awk -F= '
      /^[[:space:]]*api-key[[:space:]]*=/ {
        sub(/^[^=]*=/, "")
        gsub(/^[[:space:]]+|[[:space:]]+$/, "")
        print
        exit
      }
    ' "${MAIN_CONFIG}"
  )"
fi
if [ -z "${api_key}" ] && command -v secrets >/dev/null 2>&1; then
  api_key="$(secrets lease typesense_api_key --ttl 15m)"
fi
if [ -z "${api_key}" ]; then
  printf 'No Typesense API key. Set TYPESENSE_API_KEY or make %s readable.\n' "${MAIN_CONFIG}" >&2
  exit 2
fi
case "${api_key}" in
  *[!A-Za-z0-9._-]*)
    printf 'Typesense API key contains unsupported config characters.\n' >&2
    exit 2
    ;;
esac

escaped_home="$(printf '%s' "${HOME}" | sed 's/[\/&]/\\&/g')"
escaped_key="$(printf '%s' "${api_key}" | sed 's/[\/&]/\\&/g')"
config_tmp="$(mktemp "${TMPDIR:-/tmp}/typesense-books-config.XXXXXX")"
plist_tmp="$(mktemp "${TMPDIR:-/tmp}/typesense-books-plist.XXXXXX")"
backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/typesense-books-backup.XXXXXX")"

sed \
  -e "s/__HOME__/${escaped_home}/g" \
  -e "s/__API_KEY__/${escaped_key}/g" \
  "${SCRIPT_DIR}/typesense-books.ini.template" > "${config_tmp}"
chmod 0600 "${config_tmp}"
sed "s/__HOME__/${escaped_home}/g" \
  "${SCRIPT_DIR}/${LABEL}.plist.template" > "${plist_tmp}"
chmod 0644 "${plist_tmp}"
plutil -lint "${plist_tmp}" >/dev/null

backup_file "${CONFIG}" config
backup_file "${TARGET_SCRIPT}" start-script
backup_file "${TARGET_PLIST}" plist
backup_file "${ENV_FILE}" env
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  was_loaded=1
fi
if launchctl print-disabled "${DOMAIN}" 2>/dev/null |
  grep -F "\"${LABEL}\" => true" >/dev/null 2>&1; then
  was_disabled=1
fi
mutated=1

launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
if ! wait_for_stop; then
  printf 'Timed out waiting for %s to stop.\n' "${LABEL}" >&2
  exit 1
fi

install -m 0600 "${config_tmp}" "${CONFIG}"
install -m 0755 "${SCRIPT_DIR}/typesense-books.sh" "${TARGET_SCRIPT}"
install -m 0644 "${plist_tmp}" "${TARGET_PLIST}"
if [ "${was_disabled}" -eq 1 ]; then
  launchctl enable "${DOMAIN}/${LABEL}"
fi
launchctl bootstrap "${DOMAIN}" "${TARGET_PLIST}"

attempt=0
while ! service_is_running || ! curl --max-time 2 -fsS "${HEALTH_URL}" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "${attempt}" -ge "${HEALTH_ATTEMPTS}" ]; then
    printf '%s did not become healthy at %s.\n' "${LABEL}" "${HEALTH_URL}" >&2
    exit 1
  fi
  sleep 1
done

if ! curl --max-time 5 -fsS "${TAILNET_HEALTH_URL}" >/dev/null; then
  printf 'Private tailnet health check failed: %s\n' "${TAILNET_HEALTH_URL}" >&2
  exit 1
fi
if ! service_is_running; then
  printf '%s stopped during health verification.\n' "${LABEL}" >&2
  exit 1
fi

upsert_env_var "${ENV_FILE}" "DOCS_TYPESENSE_URL" "http://127.0.0.1:8110"
committed=1

printf 'Installed %s on http://127.0.0.1:8110\n' "${LABEL}"
printf 'Verified private tailnet route: %s\n' "${TAILNET_HEALTH_URL}"
launchctl print "${DOMAIN}/${LABEL}" | grep -E 'state =|runs =|last exit code' || true
