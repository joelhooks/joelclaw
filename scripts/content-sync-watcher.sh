#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/joel/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CLI="${HOME}/.bun/bin/joelclaw"
ENV_FILE="${HOME}/.config/system-bus.env"
CONTENT_PAYLOAD='{"source":"fswatch"}'

if [ ! -x "$CLI" ]; then
  echo "content-sync-watcher: missing CLI at $CLI" >&2
  exit 1
fi

read_queue_pilots() {
  if [ ! -f "$ENV_FILE" ]; then
    return 0
  fi

  grep '^QUEUE_PILOTS=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-
}

trim() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

pilot_enabled() {
  local needle raw value normalized
  needle="$(lower "$1")"
  raw="$(read_queue_pilots)"

  IFS=','
  for value in $raw; do
    normalized="$(lower "$(trim "$value")")"
    if [ -n "$normalized" ] && [ "$normalized" = "$needle" ]; then
      return 0
    fi
  done

  return 1
}

if pilot_enabled "content"; then
  exec "$CLI" queue emit content/updated -d "$CONTENT_PAYLOAD"
fi

exec "$CLI" send content/updated -d "$CONTENT_PAYLOAD"
