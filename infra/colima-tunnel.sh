#!/bin/bash
# Persistent SSH tunnel from macOS host to the Colima VM.
# Forwards k8s/NodePort surfaces onto localhost without relying on stale SSH ports.
# Canonical source for com.joel.colima-tunnel.

set -euo pipefail

export HOME="${HOME:-/Users/joel}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin"

LOG_TAG="colima-tunnel"
SSH_KEY="${HOME}/.colima/_lima/_config/user"
SSH_SOCKET="${HOME}/.colima/_lima/colima/ssh.sock"
AUTOSSH_PID=""

log() {
  logger -t "$LOG_TAG" "$1"
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1"
}

get_ssh_port() {
  colima ssh-config 2>/dev/null | awk '/^  Port / { print $2; exit }'
}

cleanup_socket() {
  if [ -e "$SSH_SOCKET" ]; then
    log "Removing stale SSH mux socket"
    rm -f "$SSH_SOCKET"
  fi
}

colima_ready() {
  colima status --json >/dev/null 2>&1 && [ -n "$(get_ssh_port || true)" ]
}

wait_for_colima() {
  local max_wait=300
  local waited=0

  until colima_ready; do
    if [ "$waited" -ge "$max_wait" ]; then
      log "ERROR: Colima not ready after ${max_wait}s, exiting"
      exit 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

ensure_nas_route() {
  colima ssh -- sudo ip route replace 192.168.1.0/24 via 192.168.64.1 dev col0 2>/dev/null || true
  log "LAN route to NAS ensured"
}

cleanup_child() {
  if [ -n "${AUTOSSH_PID:-}" ] && kill -0 "$AUTOSSH_PID" 2>/dev/null; then
    log "Stopping autossh child pid ${AUTOSSH_PID}"
    kill "$AUTOSSH_PID" 2>/dev/null || true
    wait "$AUTOSSH_PID" 2>/dev/null || true
  fi
  AUTOSSH_PID=""
}

kill_stale_tunnel_listeners() {
  local ports=(3838 6379 7880 7881 8288 8289 9627)
  local port
  local pid
  local comm

  for port in "${ports[@]}"; do
    while read -r pid; do
      [ -n "$pid" ] || continue
      comm="$(ps -p "$pid" -o comm= 2>/dev/null | tr -d '[:space:]')"
      case "$comm" in
        ssh|autossh)
          log "Killing stale ${comm} listener on port ${port} (pid ${pid})"
          kill "$pid" 2>/dev/null || true
          ;;
      esac
    done < <(/usr/sbin/lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | sort -u)
  done
}

log "Starting colima-tunnel"

FORWARDS=(
  # NOTE: port 3111 NOT forwarded — local system-bus-worker already listens on it.
  # NOTE: port 8108 is owned by the dedicated typesense port-forward daemon.
  "-L 3838:127.0.0.1:3838"   # docs-api
  "-L 6379:127.0.0.1:6379"   # Redis
  "-L 7880:127.0.0.1:7880"   # LiveKit HTTP
  "-L 7881:127.0.0.1:7881"   # LiveKit TCP
  "-L 8288:127.0.0.1:8288"   # Inngest server
  "-L 8289:127.0.0.1:8289"   # Inngest event API
  "-L 9627:127.0.0.1:9627"   # Bluesky PDS
)

log "Forwarding ${#FORWARDS[@]} ports via autossh"

export AUTOSSH_GATETIME=0
export AUTOSSH_POLL=30

trap cleanup_child EXIT INT TERM

start_autossh() {
  local ssh_port="$1"

  cleanup_socket
  kill_stale_tunnel_listeners
  ensure_nas_route

  log "Starting autossh against Colima SSH port ${ssh_port}"
  autossh -M 0 \
    -o "ControlPath=none" \
    -o "ServerAliveInterval=10" \
    -o "ServerAliveCountMax=3" \
    -o "ExitOnForwardFailure=yes" \
    -o "StrictHostKeyChecking=no" \
    -o "UserKnownHostsFile=/dev/null" \
    -i "$SSH_KEY" \
    -p "$ssh_port" \
    "${FORWARDS[@]}" \
    joel@127.0.0.1 -N &
  AUTOSSH_PID=$!
}

while true; do
  wait_for_colima

  SSH_PORT="$(get_ssh_port)"
  if [ -z "$SSH_PORT" ]; then
    log "ERROR: Could not determine Colima SSH port"
    sleep 5
    continue
  fi

  start_autossh "$SSH_PORT"
  LAST_ROUTE_ENSURE="$(date +%s)"

  while kill -0 "$AUTOSSH_PID" 2>/dev/null; do
    sleep 5

    CURRENT_PORT="$(get_ssh_port || true)"
    if [ -n "$CURRENT_PORT" ] && [ "$CURRENT_PORT" != "$SSH_PORT" ]; then
      log "Detected Colima SSH port drift (${SSH_PORT} -> ${CURRENT_PORT}); restarting tunnel"
      cleanup_child
      break
    fi

    NOW="$(date +%s)"
    if [ $((NOW - LAST_ROUTE_ENSURE)) -ge 30 ]; then
      ensure_nas_route
      LAST_ROUTE_ENSURE="$NOW"
    fi
  done

  if [ -n "${AUTOSSH_PID:-}" ]; then
    wait "$AUTOSSH_PID" || true
    log "autossh exited; restarting tunnel supervision loop"
    AUTOSSH_PID=""
  fi

  sleep 2
done
