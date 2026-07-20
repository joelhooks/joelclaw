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
SERVICE_PLACEMENT_FILE="${REPO_ROOT}/packages/endpoint-resolver/config/service-placement.json"
HOSTNAME_SHORT="${JOELCLAW_HOSTNAME_OVERRIDE:-$(hostname -s)}"
JQ_BIN="${JQ_BIN:-/opt/homebrew/bin/jq}"

HEADLESS_RUNTIME_LABELS=(
  com.joel.agent-secrets
  com.joel.system-bus-worker
  com.joel.gateway
  com.joelclaw.agent-mail
  com.joelclaw.herdr-server
  com.joelclaw.wiki-serve
  com.joelclaw.wiki-serve-check
)
K8S_LABELS=(
  com.joel.colima
  com.joel.k8s-reboot-heal
  com.joel.kube-operator-access
)
CRITICAL_LABELS=()

[ -x "$JQ_BIN" ] || {
  echo "Missing jq executable: $JQ_BIN"
  exit 1
}
[ -f "$SERVICE_PLACEMENT_FILE" ] || {
  echo "Missing service placement config: $SERVICE_PLACEMENT_FILE"
  exit 1
}

HEADLESS_RUNTIME_HOST="$($JQ_BIN -r 'first(.hosts[] | select(.services | index("joelclaw-headless-runtime")) | .hostname) // empty' "$SERVICE_PLACEMENT_FILE")"
K8S_HOST="$($JQ_BIN -r 'first(.hosts[] | select(.services | index("k8s")) | .hostname) // empty' "$SERVICE_PLACEMENT_FILE")"

if [ "$HOSTNAME_SHORT" = "$HEADLESS_RUNTIME_HOST" ]; then
  CRITICAL_LABELS+=("${HEADLESS_RUNTIME_LABELS[@]}")
fi
if [ "$HOSTNAME_SHORT" = "$K8S_HOST" ]; then
  CRITICAL_LABELS+=("${K8S_LABELS[@]}")
fi
INSTALL_MODE="install"
if [ "${#CRITICAL_LABELS[@]}" -eq 0 ]; then
  INSTALL_MODE="cleanup-only"
fi

require_executable() {
  local path="$1"
  [ -x "$path" ] || {
    echo "Missing executable dependency: $path"
    exit 1
  }
}

require_directory() {
  local path="$1"
  [ -d "$path" ] || {
    echo "Missing directory dependency: $path"
    exit 1
  }
}

preflight_selected_assets() {
  local label
  local plist

  for label in "${CRITICAL_LABELS[@]}"; do
    plist="${REPO_ROOT}/infra/launchd/${label}.plist"
    [ -f "$plist" ] || {
      echo "Missing launchd source: $plist"
      exit 1
    }
    /usr/bin/plutil -lint "$plist" >/dev/null
  done

  if [ "$HOSTNAME_SHORT" = "$HEADLESS_RUNTIME_HOST" ]; then
    require_executable "${TARGET_HOME}/.local/bin/secrets"
    require_executable "${TARGET_HOME}/.local/bin/worker-supervisor"
    require_executable "${TARGET_HOME}/.local/bin/herdr"
    require_executable "${TARGET_HOME}/.bun/bin/bun"
    require_executable "${REPO_ROOT}/infra/agent-secrets-daemon.sh"
    require_executable "${TARGET_HOME}/.joelclaw/scripts/gateway-start.sh"
    require_executable "${REPO_ROOT}/infra/agent-mail-daemon.sh"
    require_executable "${REPO_ROOT}/infra/gateway-daemon.sh"
    require_executable "${REPO_ROOT}/infra/herdr-server-daemon.sh"
    require_executable "${TARGET_HOME}/Code/joelhooks/joelclaw-wiki/scripts/wiki-serve.sh"
    require_executable "${TARGET_HOME}/Code/joelhooks/joelclaw-wiki/scripts/wiki-serve-check.sh"
    require_executable "/usr/bin/python3"
    require_directory "${REPO_ROOT}/infra/worker-supervisor"
    require_directory "${TARGET_HOME}/Code/joelhooks/joelclaw-wiki/build"

    if [ -d "${TARGET_HOME}/Code/joelhooks/mcp_agent_mail" ]; then
      require_directory "${TARGET_HOME}/Code/joelhooks/mcp_agent_mail"
    elif [ -d "${TARGET_HOME}/Code/Dicklesworthstone/mcp_agent_mail" ]; then
      require_directory "${TARGET_HOME}/Code/Dicklesworthstone/mcp_agent_mail"
    else
      echo "Missing agent-mail checkout: expected joelhooks/mcp_agent_mail"
      exit 1
    fi

    if [ ! -x "${TARGET_HOME}/.local/bin/uv" ] && [ ! -x "/opt/homebrew/bin/uv" ]; then
      echo "Missing uv executable for agent-mail"
      exit 1
    fi
  fi

  if [ "$HOSTNAME_SHORT" = "$K8S_HOST" ]; then
    require_executable "${REPO_ROOT}/infra/colima-start.sh"
    require_executable "${REPO_ROOT}/infra/k8s-reboot-heal.sh"
    require_executable "${REPO_ROOT}/infra/kube-operator-access.sh"
  fi
}

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

kill_verified_socket_owner() {
  local socket_path="$1"
  local expected_command="$2"
  local pid
  local command
  local owner_user

  [ -S "$socket_path" ] || return 0
  for pid in $(/usr/sbin/lsof -t "$socket_path" 2>/dev/null | sort -u); do
    owner_user="$(ps -p "$pid" -o user= 2>/dev/null | tr -d ' ' || true)"
    [ "$owner_user" = "$TARGET_USER" ] || continue
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$command" in
      *"$expected_command"*) kill "$pid" >/dev/null 2>&1 || true ;;
    esac
  done
}

kill_verified_port_owner() {
  local port="$1"
  local expected_command="$2"
  local pid
  local command
  local owner_user

  for pid in $(/usr/sbin/lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u); do
    owner_user="$(ps -p "$pid" -o user= 2>/dev/null | tr -d ' ' || true)"
    [ "$owner_user" = "$TARGET_USER" ] || continue
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$command" in
      *"$expected_command"*) kill "$pid" >/dev/null 2>&1 || true ;;
    esac
  done
}

stop_manual_fallbacks() {
  if [ "$HOSTNAME_SHORT" = "$HEADLESS_RUNTIME_HOST" ]; then
    pkill -f "${TARGET_HOME}/.local/bin/worker-supervisor" >/dev/null 2>&1 || true
    pkill -f "${REPO_ROOT}/packages/gateway/src/daemon.ts" >/dev/null 2>&1 || true
    pkill -f "${TARGET_HOME}/.joelclaw/scripts/gateway-start.sh" >/dev/null 2>&1 || true
    kill_verified_socket_owner \
      "${TARGET_HOME}/.agent-secrets/agent-secrets.sock" \
      "${TARGET_HOME}/.local/bin/secrets serve"
    kill_verified_port_owner \
      8765 \
      'mcp_agent_mail.cli import app; app() -- serve-http --port 8765'
    kill_verified_port_owner \
      8790 \
      "-m http.server 8790 --bind 127.0.0.1 --directory ${TARGET_HOME}/Code/joelhooks/joelclaw-wiki/build"
  fi

  if [ "$HOSTNAME_SHORT" = "$K8S_HOST" ]; then
    pkill -f "${TARGET_HOME}/.local/bin/colima-tunnel" >/dev/null 2>&1 || true
    pkill -f "${REPO_ROOT}/infra/colima-tunnel.sh" >/dev/null 2>&1 || true
    pkill -f 'autossh .*127\.0\.0\.1:6379' >/dev/null 2>&1 || true
    pkill -f '127\.0\.0\.1:16443:10\.5\.0\.2:6443' >/dev/null 2>&1 || true
    pkill -f '127\.0\.0\.1:15000:10\.5\.0\.2:50000' >/dev/null 2>&1 || true
    cancel_mux_forward '16443:10.5.0.2:6443'
    cancel_mux_forward '127.0.0.1:15000:10.5.0.2:50000'
    pkill -f 'svc/typesense 8108:8108' >/dev/null 2>&1 || true
  fi
}

bootstrap_system_daemon() {
  local label="$1"
  local plist_path="${SYSTEM_DAEMONS_DIR}/${label}.plist"

  launchctl bootstrap system "$plist_path"
  launchctl kickstart -k "system/${label}" >/dev/null 2>&1 || true
}

herdr_server_has_owner() {
  local socket_path="${TARGET_HOME}/.config/herdr/herdr.sock"
  [ -S "$socket_path" ] && /usr/sbin/lsof -t "$socket_path" >/dev/null 2>&1
}

preflight_selected_assets
ensure_runtime_dirs
remove_headless_bridge
stop_manual_fallbacks
if [ "$HOSTNAME_SHORT" = "$HEADLESS_RUNTIME_HOST" ]; then
  remove_user_agent "com.joelhooks.agent-secrets"
fi
remove_user_agent "com.joel.colima-tunnel"
remove_system_service "com.joel.colima-tunnel"
remove_user_agent "com.joel.typesense-portforward"
remove_system_service "com.joel.typesense-portforward"

if [ "$HOSTNAME_SHORT" != "$HEADLESS_RUNTIME_HOST" ]; then
  for label in "${HEADLESS_RUNTIME_LABELS[@]}"; do
    remove_user_agent "$label"
    remove_system_service "$label"
  done
fi
if [ "$HOSTNAME_SHORT" != "$K8S_HOST" ]; then
  for label in "${K8S_LABELS[@]}"; do
    remove_user_agent "$label"
    remove_system_service "$label"
  done
fi
sleep 2

HERDR_SYSTEM_PRESERVED=false
for label in "${CRITICAL_LABELS[@]}"; do
  if [ "$label" = "com.joelclaw.herdr-server" ] && herdr_server_has_owner; then
    # Removing a loaded herdr job can kill every live pane. Remove only the
    # on-disk user plist, then either load a waiting system wrapper for a
    # detached incumbent or leave an already-loaded system job untouched.
    rm -f "${LAUNCH_AGENTS_DIR}/${label}.plist"
    if launchctl print "system/${label}" >/dev/null 2>&1; then
      HERDR_SYSTEM_PRESERVED=true
    else
      remove_system_service "$label"
    fi
  else
    remove_user_agent "$label"
    remove_system_service "$label"
  fi
  install_daemon_plist "$label"
done

for label in "${CRITICAL_LABELS[@]}"; do
  if [ "$label" = "com.joelclaw.herdr-server" ] && [ "$HERDR_SYSTEM_PRESERVED" = true ]; then
    continue
  fi
  bootstrap_system_daemon "$label"
done

INSTALLED_SUMMARY="  (none)"
QUICK_CHECKS="  (none)"
if [ "${#CRITICAL_LABELS[@]}" -gt 0 ]; then
  INSTALLED_SUMMARY="$(printf '  - %s\n' "${CRITICAL_LABELS[@]}")"
  QUICK_CHECKS="$(printf '  launchctl print system/%s | rg '\''state =|pid =|last exit code'\''\n' "${CRITICAL_LABELS[@]}")"
fi

SKIPPED_HEADLESS_SUMMARY=""
if [ "$HOSTNAME_SHORT" != "$HEADLESS_RUNTIME_HOST" ]; then
  SKIPPED_HEADLESS_SUMMARY="Skipped and removed non-local headless runtime daemons:
$(printf '  - %s\n' "${HEADLESS_RUNTIME_LABELS[@]}")"
fi

SKIPPED_K8S_SUMMARY=""
if [ "$HOSTNAME_SHORT" != "$K8S_HOST" ]; then
  SKIPPED_K8S_SUMMARY="Skipped and removed non-local k8s daemons:
$(printf '  - %s\n' "${K8S_LABELS[@]}")"
fi

cat <<EOF
Installed boot-safe launchd runtime for ${TARGET_USER}.

Canonical repo source:
  ${REPO_ROOT}/infra/launchd

Host placement:
  host: ${HOSTNAME_SHORT}
  mode: ${INSTALL_MODE}
  headless runtime host: ${HEADLESS_RUNTIME_HOST:-unconfigured}
  k8s host: ${K8S_HOST:-unconfigured}

Installed system daemons:
${INSTALLED_SUMMARY}
${SKIPPED_HEADLESS_SUMMARY}
${SKIPPED_K8S_SUMMARY}
Old bridge removed:
  /Library/LaunchDaemons/com.joel.headless-bootstrap.plist
Deprecated daemons removed:
  /Library/LaunchDaemons/com.joel.colima-tunnel.plist
  /Library/LaunchDaemons/com.joel.typesense-portforward.plist

Quick checks:
${QUICK_CHECKS}
  joelclaw status
  joelclaw gateway status
  joelclaw knowledge search "launchd runtime"
EOF
