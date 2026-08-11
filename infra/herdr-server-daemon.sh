#!/bin/bash
set -euo pipefail

export HOME="/Users/joel"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

HERDR_BIN="${HERDR_BIN:-$HOME/.local/bin/herdr}"
HERDR_SESSION="${HERDR_SESSION:-}"
if [ -n "$HERDR_SESSION" ]; then
  HERDR_SOCKET="${HERDR_SOCKET:-$HOME/.config/herdr/sessions/${HERDR_SESSION}/herdr.sock}"
else
  HERDR_SOCKET="${HERDR_SOCKET:-$HOME/.config/herdr/herdr.sock}"
fi

[ -x "$HERDR_BIN" ] || {
  echo "herdr server binary is missing or not executable: $HERDR_BIN" >&2
  exit 1
}

# The installer can load this job while a detached herdr server still owns the
# live panes. Wait for that server instead of replacing it and losing terminal
# continuity. At boot there is no incumbent, so launchd reaches exec immediately.
while [ -S "$HERDR_SOCKET" ] && /usr/sbin/lsof -t "$HERDR_SOCKET" >/dev/null 2>&1; do
  sleep 5
done

if [ -n "$HERDR_SESSION" ]; then
  exec "$HERDR_BIN" --session "$HERDR_SESSION" server
fi
exec "$HERDR_BIN" server
