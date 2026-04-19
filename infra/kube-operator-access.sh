#!/bin/bash
set -euo pipefail

export PATH="/Users/joel/.local/bin:/Users/joel/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

TARGET_HOME="${HOME:-/Users/joel}"
SSH_CONFIG="${KUBE_OPERATOR_SSH_CONFIG:-${TARGET_HOME}/.colima/_lima/colima/ssh.config}"
SSH_HOST="${KUBE_OPERATOR_SSH_HOST:-lima-colima}"
TARGET_NODE="${KUBE_OPERATOR_TARGET_NODE:-10.5.0.2}"
LOCAL_KUBE_PORT="${KUBE_OPERATOR_LOCAL_KUBE_PORT:-16443}"
LOCAL_TALOS_PORT="${KUBE_OPERATOR_LOCAL_TALOS_PORT:-15000}"
TARGET_KUBE_PORT="${KUBE_OPERATOR_TARGET_KUBE_PORT:-6443}"
TARGET_TALOS_PORT="${KUBE_OPERATOR_TARGET_TALOS_PORT:-50000}"
KUBE_CONTEXT="${KUBE_OPERATOR_KUBE_CONTEXT:-admin@joelclaw}"
KUBE_CLUSTER="${KUBE_OPERATOR_KUBE_CLUSTER:-joelclaw}"
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

need ssh
need nc
need talosctl
need kubectl

[ -f "$SSH_CONFIG" ] || {
  log "missing ssh config: $SSH_CONFIG"
  exit 1
}

mkdir -p "${TARGET_HOME}/.kube"

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
