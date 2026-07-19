#!/bin/bash
set -euo pipefail

export HOME="/Users/joel"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

HERDR_BIN="${HERDR_BIN:-$HOME/.local/bin/herdr}"
HERDR_SOCKET="${HERDR_SOCKET:-$HOME/.config/herdr/herdr.sock}"

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

exec "$HERDR_BIN" server
