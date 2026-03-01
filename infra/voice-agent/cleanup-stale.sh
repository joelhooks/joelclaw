#!/bin/bash
set -euo pipefail

PORT="8081"
SERVICE_LABEL="com.joel.voice-agent"
SERVICE_TARGET="user/501/${SERVICE_LABEL}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

is_positive_int() {
  case "${1:-}" in
    ''|*[!0-9]*)
      return 1
      ;;
    *)
      [ "$1" -gt 0 ] 2>/dev/null
      ;;
  esac
}

describe_process() {
  local pid="$1"
  local command

  command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  if [ -n "$command" ]; then
    echo "$command"
  else
    echo "<process exited>"
  fi
}

is_descendant_of() {
  local child_pid="$1"
  local ancestor_pid="$2"
  local current_pid="$child_pid"
  local parent_pid

  while is_positive_int "$current_pid" && [ "$current_pid" -gt 1 ]; do
    if [ "$current_pid" -eq "$ancestor_pid" ]; then
      return 0
    fi

    parent_pid="$(ps -o ppid= -p "$current_pid" 2>/dev/null | awk '{print $1}')"
    if ! is_positive_int "$parent_pid"; then
      break
    fi

    current_pid="$parent_pid"
  done

  return 1
}

is_voice_agent_process() {
  local pid="$1"
  local command

  command="$(ps -o command= -p "$pid" 2>/dev/null || true)"

  case "$command" in
    *"infra/voice-agent"*|*"main.py"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

get_launchd_state() {
  local launchd_output

  SERVICE_LOADED=0
  SERVICE_PID=""

  launchd_output="$(launchctl print "$SERVICE_TARGET" 2>/dev/null || true)"

  if [ -n "$launchd_output" ]; then
    SERVICE_LOADED=1
    SERVICE_PID="$(printf '%s\n' "$launchd_output" | awk '/^[[:space:]]*pid = [0-9]+/ {gsub(";", "", $3); print $3; exit}')"
  fi
}

pids_as_line() {
  printf '%s\n' "$1" | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}

log "voice-agent stale-process cleanup starting"

get_launchd_state

if [ "$SERVICE_LOADED" -eq 1 ]; then
  if is_positive_int "$SERVICE_PID"; then
    log "launchd service loaded with pid $SERVICE_PID"
  else
    SERVICE_PID=""
    log "launchd service loaded, but no active pid reported"
  fi
else
  log "launchd service not loaded: $SERVICE_TARGET"
fi

PORT_PIDS="$(lsof -ti :"$PORT" 2>/dev/null | sort -u || true)"
if [ -n "$PORT_PIDS" ]; then
  log "listeners on :$PORT -> $(pids_as_line "$PORT_PIDS")"
else
  log "no listeners found on :$PORT"
fi

STALE_PIDS=""

if [ -n "$PORT_PIDS" ]; then
  for pid in $PORT_PIDS; do
    if ! is_positive_int "$pid"; then
      continue
    fi

    if is_positive_int "$SERVICE_PID"; then
      if [ "$pid" -eq "$SERVICE_PID" ]; then
        log "keeping pid $pid (launchd-managed pid)"
        continue
      fi

      if is_descendant_of "$pid" "$SERVICE_PID"; then
        log "keeping pid $pid (child of launchd-managed pid $SERVICE_PID)"
        continue
      fi
    fi

    if is_voice_agent_process "$pid"; then
      STALE_PIDS="$STALE_PIDS $pid"
    else
      log "leaving pid $pid on :$PORT (not matched as voice-agent): $(describe_process "$pid")"
    fi
  done
fi

if [ -n "$STALE_PIDS" ]; then
  for pid in $STALE_PIDS; do
    log "killing stale voice-agent pid $pid: $(describe_process "$pid")"
    kill "$pid" 2>/dev/null || log "WARNING: failed to send SIGTERM to pid $pid"
  done

  sleep 1

  for pid in $STALE_PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      log "pid $pid still running; sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || log "WARNING: failed to send SIGKILL to pid $pid"
    fi
  done
else
  log "no stale voice-agent listeners detected on :$PORT"
fi

REMAINING_PIDS="$(lsof -ti :"$PORT" 2>/dev/null | sort -u || true)"
if [ -n "$REMAINING_PIDS" ]; then
  log "post-cleanup listeners on :$PORT -> $(pids_as_line "$REMAINING_PIDS")"
else
  log "post-cleanup check: :$PORT is free"
fi

if [ "$SERVICE_LOADED" -eq 1 ]; then
  log "kickstarting launchd service: $SERVICE_TARGET"
  if launchctl kickstart -k "$SERVICE_TARGET" >/dev/null 2>&1; then
    log "kickstart completed: $SERVICE_TARGET"
  else
    log "WARNING: kickstart failed: $SERVICE_TARGET"
    exit 1
  fi
else
  log "skipping kickstart; service not loaded: $SERVICE_TARGET"
fi

log "voice-agent stale-process cleanup complete"
