#!/bin/zsh
set -euo pipefail

LOCAL_PORT="${SYSTEM_BUS_LOCAL_PORT:-3111}"
CENTRAL_HOST="${SYSTEM_BUS_CENTRAL_HOST:-flagg}"
CENTRAL_PORT="${SYSTEM_BUS_CENTRAL_PORT:-3111}"

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
