#!/bin/bash
# Gateway tripwire — fires if no heartbeat in 30 minutes
# The gateway extension writes timestamp to /tmp/joelclaw/last-heartbeat.ts on each heartbeat

HEARTBEAT_FILE="/tmp/joelclaw/last-heartbeat.ts"
THRESHOLD=1800  # 30 minutes in seconds

if [ ! -f "$HEARTBEAT_FILE" ]; then
  osascript -e 'display notification "Gateway heartbeat file missing!" with title "🚨 joelclaw"'
  exit 0
fi

LAST=$(stat -f %m "$HEARTBEAT_FILE")
NOW=$(date +%s)
AGE=$((NOW - LAST))

if [ $AGE -gt $THRESHOLD ]; then
  osascript -e "display notification \"Gateway heartbeat stale (${AGE}s ago)\" with title \"🚨 joelclaw\""
fi
