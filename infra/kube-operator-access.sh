#!/bin/bash
set -euo pipefail

export PATH="/Users/joel/.local/bin:/Users/joel/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

TARGET_HOME="${HOME:-/Users/joel}"
MODE="${KUBE_OPERATOR_MODE:-direct}"
SSH_CONFIG="${KUBE_OPERATOR_SSH_CONFIG:-${TARGET_HOME}/.colima/_lima/colima/ssh.config}"
SSH_HOST="${KUBE_OPERATOR_SSH_HOST:-lima-colima}"
TARGET_NODE="${KUBE_OPERATOR_TARGET_NODE:-10.5.0.2}"
LOCAL_KUBE_PORT="${KUBE_OPERATOR_LOCAL_KUBE_PORT:-6443}"
LOCAL_TALOS_PORT="${KUBE_OPERATOR_LOCAL_TALOS_PORT:-50000}"
# A stale installed launchd plist may still export 16443/15000 from the old SSH-tunnel era.
# Direct mode is the normal path now; ignore those legacy env vars unless explicitly allowed.
if [ "$MODE" = "direct" ] && [ "${KUBE_OPERATOR_ALLOW_CUSTOM_DIRECT_PORTS:-}" != "1" ]; then
  LOCAL_KUBE_PORT="6443"
  LOCAL_TALOS_PORT="50000"
fi
TARGET_KUBE_PORT="${KUBE_OPERATOR_TARGET_KUBE_PORT:-6443}"
TARGET_TALOS_PORT="${KUBE_OPERATOR_TARGET_TALOS_PORT:-50000}"
KUBE_CONTEXT="${KUBE_OPERATOR_KUBE_CONTEXT:-admin@joelclaw}"
KUBE_CLUSTER="${KUBE_OPERATOR_KUBE_CLUSTER:-joelclaw}"
READY_TIMEOUT_SECS="${KUBE_OPERATOR_READY_TIMEOUT_SECS:-300}"
MONITOR_INTERVAL_SECS="${KUBE_OPERATOR_MONITOR_INTERVAL_SECS:-30}"
SSH_PID=""
REFRESH_PID=""

log() {
  printf '[kube-operator-access] %s\n' "$*"
}

cleanup() {
  if [ -n "$REFRESH_PID" ] && kill -0 "$REFRESH_PID" >/dev/null 2>&1; then
    kill "$REFRESH_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$SSH_PID" ] && kill -0 "$SSH_PID" >/dev/null 2>&1; then
    kill "$SSH_PID" >/dev/null 2>&1 || true
    wait "$SSH_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

need() {
  command -v "$1" >/dev/null 2>&1 || {
    log "missing required command: $1"
    exit 1
  }
}

port_open() {
  nc -z 127.0.0.1 "$1" >/dev/null 2>&1
}

configure_talos() {
  talosctl config endpoint "127.0.0.1:${LOCAL_TALOS_PORT}" >/dev/null 2>&1 || true
  talosctl config node "$TARGET_NODE" >/dev/null 2>&1 || true
}

configure_kube() {
  talosctl -e "127.0.0.1:${LOCAL_TALOS_PORT}" -n "$TARGET_NODE" kubeconfig --force "${TARGET_HOME}/.kube/config" >/dev/null 2>&1 || return 1
  kubectl config unset "clusters.${KUBE_CLUSTER}.certificate-authority-data" >/dev/null 2>&1 || true
  kubectl config unset "clusters.${KUBE_CLUSTER}.certificate-authority" >/dev/null 2>&1 || true
  kubectl config set-cluster "$KUBE_CLUSTER" \
    --server="https://127.0.0.1:${LOCAL_KUBE_PORT}" \
    --insecure-skip-tls-verify=true >/dev/null 2>&1 || true
  kubectl config use-context "$KUBE_CONTEXT" >/dev/null 2>&1 || true
}

configure_operator_access() {
  configure_talos
  configure_kube || return 1
  kubectl --request-timeout=10s get nodes >/dev/null 2>&1 || return 1
}

wait_for_direct_access() {
  local deadline=$((SECONDS + READY_TIMEOUT_SECS))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if port_open "$LOCAL_KUBE_PORT" && port_open "$LOCAL_TALOS_PORT" && configure_operator_access; then
      log "updated talosctl + kubeconfig to direct Colima-published ports"
      return 0
    fi

    sleep 5
  done

  log "direct operator ports did not become ready within ${READY_TIMEOUT_SECS}s"
  return 1
}

monitor_direct_access() {
  local was_ready=0

  log "starting direct operator access monitor on 127.0.0.1:${LOCAL_KUBE_PORT} and 127.0.0.1:${LOCAL_TALOS_PORT}"
  wait_for_direct_access
  was_ready=1

  while true; do
    sleep "$MONITOR_INTERVAL_SECS"

    if port_open "$LOCAL_KUBE_PORT" && port_open "$LOCAL_TALOS_PORT"; then
      if [ "$was_ready" -eq 0 ] || ! kubectl --request-timeout=10s get nodes >/dev/null 2>&1; then
        if configure_operator_access; then
          log "direct operator access ready"
          was_ready=1
        else
          log "WARNING: direct ports are open but kube/talos config refresh failed"
          was_ready=0
        fi
      fi
    else
      if [ "$was_ready" -eq 1 ]; then
        log "WARNING: direct operator ports unavailable; waiting for Colima/Lima to republish"
      fi
      was_ready=0
    fi
  done
}

refresh_configs_until_ready() {
  local attempt

  for attempt in $(seq 1 60); do
    if ! kill -0 "$SSH_PID" >/dev/null 2>&1; then
      return 1
    fi

    if port_open "$LOCAL_TALOS_PORT"; then
      configure_talos
      if configure_kube; then
        log "updated talosctl + kubeconfig to stable local operator ports"
        return 0
      fi
    fi

    sleep 5
  done

  log "WARNING: operator tunnel is up but kubeconfig refresh never completed"
  return 0
}

need nc
need talosctl
need kubectl

mkdir -p "${TARGET_HOME}/.kube"

case "$MODE" in
  direct)
    monitor_direct_access
    ;;
  ssh)
    need ssh
    [ -f "$SSH_CONFIG" ] || {
      log "missing ssh config: $SSH_CONFIG"
      exit 1
    }
    ;;
  *)
    log "unknown KUBE_OPERATOR_MODE: $MODE"
    exit 1
    ;;
esac

log "starting dedicated operator tunnel on 127.0.0.1:${LOCAL_KUBE_PORT} and 127.0.0.1:${LOCAL_TALOS_PORT}"
ssh -F "$SSH_CONFIG" \
  -S none \
  -o ControlPath=none \
  -o ControlMaster=no \
  -o ControlPersist=no \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -N \
  -L "127.0.0.1:${LOCAL_KUBE_PORT}:${TARGET_NODE}:${TARGET_KUBE_PORT}" \
  -L "127.0.0.1:${LOCAL_TALOS_PORT}:${TARGET_NODE}:${TARGET_TALOS_PORT}" \
  "$SSH_HOST" &
SSH_PID=$!

for _ in $(seq 1 30); do
  if ! kill -0 "$SSH_PID" >/dev/null 2>&1; then
    wait "$SSH_PID"
  fi
  if port_open "$LOCAL_KUBE_PORT" && port_open "$LOCAL_TALOS_PORT"; then
    break
  fi
  sleep 1
done

if ! port_open "$LOCAL_KUBE_PORT" || ! port_open "$LOCAL_TALOS_PORT"; then
  log "operator tunnel ports never became ready"
  wait "$SSH_PID"
fi

refresh_configs_until_ready &
REFRESH_PID=$!

wait "$SSH_PID"
