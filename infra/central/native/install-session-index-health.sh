#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LABEL="com.joelclaw.central.session-index-health"
TARGET_SCRIPT="/Users/Shared/joelclaw/bin/session-index-health"
TARGET_PLIST="/Library/LaunchDaemons/${LABEL}.plist"

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run once with sudo: sudo %s\n' "$0" >&2
  exit 2
fi

install -d -o root -g staff -m 0755 /Users/Shared/joelclaw/bin
install -d -o root -g staff -m 0755 /Users/Shared/joelclaw/logs
install -d -o root -g staff -m 0755 /Users/Shared/joelclaw/state/session-index-health
install -o root -g wheel -m 0755 "${SCRIPT_DIR}/session-index-health.sh" "${TARGET_SCRIPT}"

# The worker refuses OTEL emits without its token. Copy OTEL_EMIT_TOKEN from the
# invoking user's system-bus env into a root-only header file; never print it.
HEADER_DIR="$(dirname "$(dirname "${TARGET_SCRIPT}")")/etc/session-index-health"
HEADER_FILE="${HEADER_DIR}/emit-token.header"
ENV_FILE="${SYSTEM_BUS_ENV_FILE:-}"
if [ -z "${ENV_FILE}" ] && [ -n "${SUDO_USER:-}" ]; then
  user_home="$(dscl . -read "/Users/${SUDO_USER}" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  [ -n "${user_home}" ] && ENV_FILE="${user_home}/.config/system-bus.env"
fi
emit_token=""
if [ -n "${ENV_FILE}" ] && [ -r "${ENV_FILE}" ]; then
  emit_token="$(sed -n 's/^OTEL_EMIT_TOKEN=//p' "${ENV_FILE}" | tail -1)"
fi
install -d -o root -g wheel -m 0700 "${HEADER_DIR}"
if [ -n "${emit_token}" ]; then
  (umask 077 && printf 'x-otel-emit-token: %s\n' "${emit_token}" >"${HEADER_FILE}")
  chown root:wheel "${HEADER_FILE}"
  chmod 0600 "${HEADER_FILE}"
  printf 'Wrote the emit token header (%s)\n' "${HEADER_FILE}"
else
  printf 'warning: no OTEL_EMIT_TOKEN in %s; OTEL posts will be refused\n' "${ENV_FILE:-<unset>}" >&2
fi
unset emit_token
install -o root -g wheel -m 0644 "${SCRIPT_DIR}/${LABEL}.plist" "${TARGET_PLIST}"
plutil -lint "${TARGET_PLIST}"

launchctl bootout "system/${LABEL}" 2>/dev/null || true
launchctl bootstrap system "${TARGET_PLIST}"
launchctl enable "system/${LABEL}"
launchctl kickstart -k "system/${LABEL}"

printf 'Installed %s\n' "${LABEL}"
launchctl print "system/${LABEL}" | grep -E 'state =|runs =|last exit code' || true
