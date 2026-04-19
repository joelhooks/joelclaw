#!/bin/bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0"
  exit 1
fi

TARGET_USER="${TARGET_USER:-joel}"
TARGET_GROUP="${TARGET_GROUP:-staff}"
TARGET_HOME="${TARGET_HOME:-/Users/${TARGET_USER}}"
TARGET_UID="$(id -u "$TARGET_USER")"
REPO_ROOT="${REPO_ROOT:-${TARGET_HOME}/Code/joelhooks/joelclaw}"
SYSTEM_DAEMONS_DIR="/Library/LaunchDaemons"
LAUNCH_AGENTS_DIR="${TARGET_HOME}/Library/LaunchAgents"

CRITICAL_LABELS=(
  com.joel.colima
  com.joel.k8s-reboot-heal
  com.joel.kube-operator-access
  com.joel.agent-secrets
  com.joel.system-bus-worker
  com.joel.gateway
  com.joelclaw.agent-mail
)

ensure_runtime_dirs() {
  mkdir -p \
    "${TARGET_HOME}/.local/log" \
    "${TARGET_HOME}/.joelclaw/logs" \
    "${TARGET_HOME}/.agent-secrets" \
    /tmp/joelclaw \
    "$LAUNCH_AGENTS_DIR"
  chown "${TARGET_USER}:${TARGET_GROUP}" \
    "${TARGET_HOME}/.local" \
    "${TARGET_HOME}/.local/log" \
    "${TARGET_HOME}/.joelclaw" \
    "${TARGET_HOME}/.joelclaw/logs" \
    "${TARGET_HOME}/.agent-secrets" \
    "$LAUNCH_AGENTS_DIR"
}

install_daemon_plist() {
  local label="$1"
  local src="${REPO_ROOT}/infra/launchd/${label}.plist"
  local dst="${SYSTEM_DAEMONS_DIR}/${label}.plist"

  install -m 644 "$src" "$dst"
  chown root:wheel "$dst"
}

bootout_if_loaded() {
  local target="$1"
  local plist_path="$2"

  launchctl print "$target" >/dev/null 2>&1 || return 0
  launchctl bootout "$target" >/dev/null 2>&1 \
    || launchctl bootout "${target%/*}" "$plist_path" >/dev/null 2>&1 \
    || true
}

remove_user_agent() {
  local label="$1"
  local plist_path="${LAUNCH_AGENTS_DIR}/${label}.plist"

  bootout_if_loaded "gui/${TARGET_UID}/${label}" "$plist_path"
  bootout_if_loaded "user/${TARGET_UID}/${label}" "$plist_path"
  rm -f "$plist_path"
}

remove_system_service() {
  local label="$1"
  local plist_path="${SYSTEM_DAEMONS_DIR}/${label}.plist"

  bootout_if_loaded "system/${label}" "$plist_path"
  rm -f "$plist_path"
}

remove_headless_bridge() {
  local label="com.joel.headless-bootstrap"
  local plist_path="${SYSTEM_DAEMONS_DIR}/${label}.plist"

  bootout_if_loaded "system/${label}" "$plist_path"
  rm -f "$plist_path"
}

cancel_mux_forward() {
  local spec="$1"
  sudo -u "$TARGET_USER" HOME="$TARGET_HOME" \
    ssh -F "${TARGET_HOME}/.colima/_lima/colima/ssh.config" \
      -O cancel \
      -L "$spec" \
      lima-colima >/dev/null 2>&1 || true
}

stop_manual_fallbacks() {
  pkill -f "${TARGET_HOME}/.local/bin/worker-supervisor" >/dev/null 2>&1 || true
  pkill -f "${REPO_ROOT}/packages/gateway/src/daemon.ts" >/dev/null 2>&1 || true
  pkill -f "${TARGET_HOME}/.joelclaw/scripts/gateway-start.sh" >/dev/null 2>&1 || true
  pkill -f "${TARGET_HOME}/.local/bin/colima-tunnel" >/dev/null 2>&1 || true
  pkill -f "${REPO_ROOT}/infra/colima-tunnel.sh" >/dev/null 2>&1 || true
  pkill -f 'autossh .*127\.0\.0\.1:6379' >/dev/null 2>&1 || true
  pkill -f '127\.0\.0\.1:16443:10\.5\.0\.2:6443' >/dev/null 2>&1 || true
  pkill -f '127\.0\.0\.1:15000:10\.5\.0\.2:50000' >/dev/null 2>&1 || true
  cancel_mux_forward '16443:10.5.0.2:6443'
  cancel_mux_forward '127.0.0.1:15000:10.5.0.2:50000'
  pkill -f 'svc/typesense 8108:8108' >/dev/null 2>&1 || true
  pkill -f "${TARGET_HOME}/.local/bin/secrets serve --socket ${TARGET_HOME}/.agent-secrets/agent-secrets.sock" >/dev/null 2>&1 || true
  pkill -f "${REPO_ROOT}/infra/agent-mail-daemon.sh" >/dev/null 2>&1 || true
  pkill -f 'serve-http --port 8765' >/dev/null 2>&1 || true
}

bootstrap_system_daemon() {
  local label="$1"
  local plist_path="${SYSTEM_DAEMONS_DIR}/${label}.plist"

  launchctl bootstrap system "$plist_path"
  launchctl kickstart -k "system/${label}" >/dev/null 2>&1 || true
}

ensure_runtime_dirs
remove_headless_bridge
stop_manual_fallbacks
remove_user_agent "com.joel.colima-tunnel"
remove_system_service "com.joel.colima-tunnel"
remove_user_agent "com.joel.typesense-portforward"
remove_system_service "com.joel.typesense-portforward"
sleep 2

for label in "${CRITICAL_LABELS[@]}"; do
  remove_user_agent "$label"
  remove_system_service "$label"
  install_daemon_plist "$label"
done

for label in "${CRITICAL_LABELS[@]}"; do
  bootstrap_system_daemon "$label"
done

cat <<EOF
Installed boot-safe launchd runtime for ${TARGET_USER}.

Canonical repo source:
  ${REPO_ROOT}/infra/launchd

Installed system daemons:
$(printf '  - %s\n' "${CRITICAL_LABELS[@]}")
Old bridge removed:
  /Library/LaunchDaemons/com.joel.headless-bootstrap.plist
Deprecated daemons removed:
  /Library/LaunchDaemons/com.joel.colima-tunnel.plist
  /Library/LaunchDaemons/com.joel.typesense-portforward.plist

Quick checks:
$(printf '  launchctl print system/%s | rg '\''state =|pid =|last exit code'\''\n' "${CRITICAL_LABELS[@]}")
  joelclaw status
  joelclaw gateway status
  joelclaw knowledge search "launchd runtime"
EOF
