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
AGENT_SECRETS_SERVICE_USER="${AGENT_SECRETS_SERVICE_USER:-joelclaw}"
AGENT_SECRETS_SOCKET_GROUP="${AGENT_SECRETS_SOCKET_GROUP:-joelclaw-secrets}"
AGENT_SECRETS_SERVICE_ROOT="${AGENT_SECRETS_SERVICE_ROOT:-/Users/Shared/joelclaw}"
AGENT_SECRETS_SERVICE_HOME="${AGENT_SECRETS_SERVICE_HOME:-/Users/${AGENT_SECRETS_SERVICE_USER}}"

HEADLESS_RUNTIME_LABELS=(
  com.joel.agent-secrets
  com.joel.system-bus-worker
  com.joel.gateway
  com.joelclaw.agent-mail
  com.joelclaw.herdr-system-server
  com.joelclaw.wiki-serve
  com.joelclaw.wiki-serve-check
)
INTERACTIVE_LAUNCH_AGENT_LABELS=(
  com.joelclaw.herdr-server
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

require_owner_mode() {
  local path="$1"
  local owner="$2"
  local group="$3"
  local mode="$4"
  local actual
  actual="$(stat -f '%Su:%Sg:%Lp' "$path")"
  [ "$actual" = "${owner}:${group}:${mode}" ] || {
    echo "Unsafe ownership or mode for $path: $actual, expected ${owner}:${group}:${mode}"
    exit 1
  }
}

validate_agent_secrets_service_runtime() {
  local store="${AGENT_SECRETS_SERVICE_HOME}/.agent-secrets"
  local socket="${AGENT_SECRETS_SERVICE_ROOT}/run/agent-secrets.sock"
  local config="${store}/config.json"
  local marker="${store}/service-account-migration.json"
  local expected_identity

  require_owner_mode "$store" "$AGENT_SECRETS_SERVICE_USER" "$AGENT_SECRETS_SOCKET_GROUP" 700
  require_owner_mode "${AGENT_SECRETS_SERVICE_ROOT}/run" "$AGENT_SECRETS_SERVICE_USER" "$AGENT_SECRETS_SOCKET_GROUP" 710
  require_owner_mode "${AGENT_SECRETS_SERVICE_ROOT}/logs" "$AGENT_SECRETS_SERVICE_USER" "$AGENT_SECRETS_SOCKET_GROUP" 700
  for path in "$config" "$marker" "${store}/identity.age" "${store}/secrets.age"; do
    require_owner_mode "$path" "$AGENT_SECRETS_SERVICE_USER" "$AGENT_SECRETS_SOCKET_GROUP" 600
    [ -s "$path" ] || { echo "Empty agent-secrets service file: $path"; exit 1; }
  done

  "$JQ_BIN" -e \
    --arg directory "$store" \
    --arg socket "$socket" \
    --arg group "$AGENT_SECRETS_SOCKET_GROUP" \
    '.directory == $directory and .socket_path == $socket and .socket_mode == "0660" and .socket_group == $group' \
    "$config" >/dev/null || {
      echo "Invalid agent-secrets service config: $config"
      exit 1
    }
  "$JQ_BIN" -e '.version == 1 and (.identity_sha256 | test("^[0-9a-f]{64}$"))' "$marker" >/dev/null || {
    echo "Invalid agent-secrets migration marker: $marker"
    exit 1
  }
  expected_identity="$("$JQ_BIN" -r '.identity_sha256' "$marker")"
  [ "$(shasum -a 256 "${store}/identity.age" | awk '{print $1}')" = "$expected_identity" ] || {
    echo "Agent-secrets service identity does not match migration marker"
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
    for label in "${INTERACTIVE_LAUNCH_AGENT_LABELS[@]}"; do
      plist="${REPO_ROOT}/infra/launchd/${label}.plist"
      [ -f "$plist" ] || {
        echo "Missing launchd source: $plist"
        exit 1
      }
      /usr/bin/plutil -lint "$plist" >/dev/null
    done

    require_executable "${TARGET_HOME}/.local/bin/secrets"
    "${TARGET_HOME}/.local/bin/secrets" daemon restart --help >/dev/null 2>&1 || {
      echo "Installed secrets binary lacks service-account restart support"
      exit 1
    }
    require_executable "${REPO_ROOT}/infra/install-agent-secrets-service-account.sh"
    id "$AGENT_SECRETS_SERVICE_USER" >/dev/null 2>&1 || {
      echo "Missing agent-secrets service account: $AGENT_SECRETS_SERVICE_USER"
      exit 1
    }
    /usr/bin/dscl . -read "/Groups/${AGENT_SECRETS_SOCKET_GROUP}" >/dev/null 2>&1 || {
      echo "Missing ${AGENT_SECRETS_SOCKET_GROUP}; run infra/install-agent-secrets-service-account.sh first"
      exit 1
    }
    require_directory "${AGENT_SECRETS_SERVICE_HOME}/.agent-secrets"
    for path in \
      "${AGENT_SECRETS_SERVICE_HOME}/.agent-secrets/config.json" \
      "${AGENT_SECRETS_SERVICE_HOME}/.agent-secrets/identity.age" \
      "${AGENT_SECRETS_SERVICE_HOME}/.agent-secrets/secrets.age" \
      "${AGENT_SECRETS_SERVICE_HOME}/.agent-secrets/service-account-migration.json"; do
      [ -f "$path" ] || {
        echo "Incomplete agent-secrets service migration; missing $path"
        exit 1
      }
    done
    validate_agent_secrets_service_runtime
    require_executable "${TARGET_HOME}/.local/bin/worker-supervisor"
    require_executable "${TARGET_HOME}/.local/bin/herdr"
    require_executable "${TARGET_HOME}/.bun/bin/bun"
    require_executable "${TARGET_HOME}/.joelclaw/scripts/gateway-start.sh"
    require_executable "${REPO_ROOT}/infra/agent-mail-daemon.sh"
    require_executable "${REPO_ROOT}/infra/gateway-daemon.sh"
    require_executable "${REPO_ROOT}/infra/herdr-server-daemon.sh"
    require_executable "${REPO_ROOT}/infra/install-herdr-default-launchagent.sh"
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

sync_agent_secrets_service_binary() {
  [ "$HOSTNAME_SHORT" = "$HEADLESS_RUNTIME_HOST" ] || return 0
  install -d -o "$AGENT_SECRETS_SERVICE_USER" -g "$AGENT_SECRETS_SOCKET_GROUP" -m 755 \
    "${AGENT_SECRETS_SERVICE_ROOT}/bin"
  install -d -o "$AGENT_SECRETS_SERVICE_USER" -g "$AGENT_SECRETS_SOCKET_GROUP" -m 700 \
    "${AGENT_SECRETS_SERVICE_ROOT}/logs"
  install -d -o "$AGENT_SECRETS_SERVICE_USER" -g "$AGENT_SECRETS_SOCKET_GROUP" -m 710 \
    "${AGENT_SECRETS_SERVICE_ROOT}/run"
  install -o "$AGENT_SECRETS_SERVICE_USER" -g "$AGENT_SECRETS_SOCKET_GROUP" -m 755 \
    "${TARGET_HOME}/.local/bin/secrets" \
    "${AGENT_SECRETS_SERVICE_ROOT}/bin/secrets"
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

is_herdr_server_label() {
  [ "$1" = "com.joelclaw.herdr-system-server" ]
}

herdr_socket_for_label() {
  if [ "$1" = "com.joelclaw.herdr-system-server" ]; then
    printf '%s\n' "${TARGET_HOME}/.config/herdr/sessions/system/herdr.sock"
  else
    printf '%s\n' "${TARGET_HOME}/.config/herdr/herdr.sock"
  fi
}

herdr_server_has_owner() {
  local socket_path
  socket_path="$(herdr_socket_for_label "$1")"
  [ -S "$socket_path" ] && /usr/sbin/lsof -t "$socket_path" >/dev/null 2>&1
}

preflight_selected_assets
ensure_runtime_dirs
sync_agent_secrets_service_binary
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
  for label in "${INTERACTIVE_LAUNCH_AGENT_LABELS[@]}"; do
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

HERDR_PRESERVED_LABELS=""
for label in "${CRITICAL_LABELS[@]}"; do
  if is_herdr_server_label "$label" && herdr_server_has_owner "$label"; then
    # Removing a loaded herdr job can kill every live pane. Remove only the
    # on-disk user plist, then either load a waiting system wrapper for a
    # detached incumbent or leave an already-loaded system job untouched.
    rm -f "${LAUNCH_AGENTS_DIR}/${label}.plist"
    if launchctl print "system/${label}" >/dev/null 2>&1; then
      HERDR_PRESERVED_LABELS="${HERDR_PRESERVED_LABELS} ${label}"
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
  case " ${HERDR_PRESERVED_LABELS} " in
    *" ${label} "*) continue ;;
  esac
  bootstrap_system_daemon "$label"
done

INTERACTIVE_SUMMARY="  (none)"
if [ "$HOSTNAME_SHORT" = "$HEADLESS_RUNTIME_HOST" ]; then
  env \
    REPO_ROOT="$REPO_ROOT" \
    TARGET_USER="$TARGET_USER" \
    TARGET_GROUP="$TARGET_GROUP" \
    TARGET_HOME="$TARGET_HOME" \
    "${REPO_ROOT}/infra/install-herdr-default-launchagent.sh"
  INTERACTIVE_SUMMARY="$(printf '  - %s\n' "${INTERACTIVE_LAUNCH_AGENT_LABELS[@]}")"
fi

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
Installed interactive GUI LaunchAgents:
${INTERACTIVE_SUMMARY}
${SKIPPED_HEADLESS_SUMMARY}
${SKIPPED_K8S_SUMMARY}
Old bridge removed:
  /Library/LaunchDaemons/com.joel.headless-bootstrap.plist
Deprecated daemons removed:
  /Library/LaunchDaemons/com.joel.colima-tunnel.plist
  /Library/LaunchDaemons/com.joel.typesense-portforward.plist

Quick checks:
${QUICK_CHECKS}
  launchctl print gui/${TARGET_UID}/com.joelclaw.herdr-server | rg 'state =|pid =|last exit code'
  joelclaw status
  joelclaw gateway status
  joelclaw knowledge search "launchd runtime"
EOF
