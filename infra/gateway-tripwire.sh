#!/bin/bash
# Gateway tripwire — fires if no heartbeat in 30 minutes
# The gateway extension writes timestamp to /tmp/joelclaw/last-heartbeat.ts on each heartbeat

HEARTBEAT_FILE="/tmp/joelclaw/last-heartbeat.ts"
THRESHOLD=1800  # 30 minutes in seconds
PID_FILE="/tmp/joelclaw/gateway.pid"

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

if [ ! -f "$HEARTBEAT_FILE" ]; then
  # Reboot/startup grace: gateway can be healthy before first heartbeat write.
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      ETIME="$(ps -p "$PID" -o etime= 2>/dev/null | tr -d '[:space:]')"
      if [ -n "$ETIME" ]; then
        UPTIME_SECS="$(etime_to_seconds "$ETIME")"
        if [ "$UPTIME_SECS" -lt "$THRESHOLD" ]; then
          exit 0
        fi
      fi
    fi
  fi

  osascript -e 'display notification "Gateway heartbeat file missing!" with title "🚨 joelclaw"'
  exit 0
fi

LAST=$(stat -f %m "$HEARTBEAT_FILE")
NOW=$(date +%s)
AGE=$((NOW - LAST))

if [ $AGE -gt $THRESHOLD ]; then
  osascript -e "display notification \"Gateway heartbeat stale (${AGE}s ago)\" with title \"🚨 joelclaw\""
fi
