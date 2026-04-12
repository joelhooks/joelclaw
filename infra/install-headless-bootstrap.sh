#!/bin/bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0"
  exit 1
fi

TARGET_USER="${TARGET_USER:-joel}"
TARGET_HOME="${TARGET_HOME:-/Users/${TARGET_USER}}"
TARGET_UID="$(id -u "$TARGET_USER")"
REPO_ROOT="${REPO_ROOT:-${TARGET_HOME}/Code/joelhooks/joelclaw}"
LAUNCH_AGENTS_DIR="${TARGET_HOME}/Library/LaunchAgents"
SYSTEM_DAEMONS_DIR="/Library/LaunchDaemons"
HEADLESS_PLIST_SRC="${REPO_ROOT}/infra/launchd/com.joel.headless-bootstrap.plist"
HEADLESS_PLIST_DST="${SYSTEM_DAEMONS_DIR}/com.joel.headless-bootstrap.plist"

mkdir -p "$LAUNCH_AGENTS_DIR"

link_launch_agent() {
  local label="$1"
  ln -sfn "${REPO_ROOT}/infra/launchd/${label}.plist" "${LAUNCH_AGENTS_DIR}/${label}.plist"
  chown -h "${TARGET_USER}:staff" "${LAUNCH_AGENTS_DIR}/${label}.plist"
}

for label in \
  com.joel.colima \
  com.joel.k8s-reboot-heal \
  com.joel.agent-secrets \
  com.joel.system-bus-worker \
  com.joel.gateway \
  com.joel.typesense-portforward \
  com.joelclaw.agent-mail
 do
  link_launch_agent "$label"
 done

install -m 644 "$HEADLESS_PLIST_SRC" "$HEADLESS_PLIST_DST"
chown root:wheel "$HEADLESS_PLIST_DST"

launchctl bootout system/com.joel.headless-bootstrap 2>/dev/null || true
launchctl bootstrap system "$HEADLESS_PLIST_DST"
launchctl kickstart -k system/com.joel.headless-bootstrap

cat <<EOF
Installed repo-managed launch agents for user ${TARGET_USER} and bootstrapped the system headless bridge.

Critical labels now sourced from:
  ${REPO_ROOT}/infra/launchd

System bridge:
  ${HEADLESS_PLIST_DST}

Next checks:
  launchctl print system/com.joel.headless-bootstrap | rg 'state =|pid =|last exit code'
  sudo tail -f ${TARGET_HOME}/.local/log/headless-bootstrap.log
  sudo launchctl print user/${TARGET_UID}/com.joel.gateway | rg 'state =|pid =|last exit code'
EOF
