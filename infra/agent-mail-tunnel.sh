#!/bin/zsh
set -euo pipefail

LOCAL_PORT="${AGENT_MAIL_LOCAL_PORT:-8765}"
CENTRAL_HOST="${AGENT_MAIL_CENTRAL_HOST:-flagg}"
CENTRAL_PORT="${AGENT_MAIL_CENTRAL_PORT:-8765}"

exec /usr/bin/ssh \
  -NT \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o TCPKeepAlive=yes \
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:${CENTRAL_PORT}" \
  "$CENTRAL_HOST"
