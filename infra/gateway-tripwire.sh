#!/bin/bash
# Gateway tripwire — checks every five minutes and notifies on unhealthy state changes.
# The gateway transport writes its PID and heartbeat after dependency preflight succeeds.
set -u

HEARTBEAT_FILE="${GATEWAY_HEARTBEAT_FILE:-/tmp/joelclaw/last-heartbeat.ts}"
THRESHOLD="${GATEWAY_TRIPWIRE_THRESHOLD_SECONDS:-1800}"
PID_FILE="${GATEWAY_PID_FILE:-/tmp/joelclaw/gateway.pid}"
STATE_FILE="${GATEWAY_TRIPWIRE_STATE_FILE:-/tmp/joelclaw/gateway-tripwire.state}"
OSASCRIPT_BIN="${GATEWAY_TRIPWIRE_OSASCRIPT_BIN:-/usr/bin/osascript}"

etime_to_seconds() {
  local etime="$1"
  local days=0 hours=0 mins=0 secs=0

  if [[ "$etime" == *-* ]]; then
    days="${etime%%-*}"
    etime="${etime#*-}"
  fi

  IFS=':' read -r p1 p2 p3 <<< "$etime"
  if [[ -n "${p3:-}" ]]; then
    hours="$p1"
    mins="$p2"
    secs="$p3"
  else
    mins="${p1:-0}"
    secs="${p2:-0}"
  fi

  echo $((days * 86400 + hours * 3600 + mins * 60 + secs))
}

current_state() {
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE" 2>/dev/null || true
  fi
}

write_state() {
  mkdir -p "$(dirname "$STATE_FILE")"
  printf '%s\n' "$1" > "$STATE_FILE"
}

notify_on_transition() {
  local next_state="$1"
  local message="$2"
  local previous_state
  previous_state="$(current_state)"
  if [ "$previous_state" != "$next_state" ]; then
    "$OSASCRIPT_BIN" -e "display notification \"$message\" with title \"🚨 joelclaw\""
  fi
  write_state "$next_state"
}

if [ ! -f "$HEARTBEAT_FILE" ]; then
  # Reboot/startup grace: the transport can be healthy before dependency
  # preflight completes and publishes its first heartbeat.
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      ETIME="$(ps -p "$PID" -o etime= 2>/dev/null | tr -d '[:space:]')"
      if [ -n "$ETIME" ]; then
        UPTIME_SECS="$(etime_to_seconds "$ETIME")"
        if [ "$UPTIME_SECS" -lt "$THRESHOLD" ]; then
          write_state starting
          exit 0
        fi
      fi
    fi
  fi

  notify_on_transition missing "Gateway heartbeat file missing!"
  exit 0
fi

LAST="$(stat -f %m "$HEARTBEAT_FILE")"
NOW="$(date +%s)"
AGE=$((NOW - LAST))

if [ "$AGE" -gt "$THRESHOLD" ]; then
  notify_on_transition stale "Gateway heartbeat stale (${AGE}s ago)"
  exit 0
fi

write_state healthy
