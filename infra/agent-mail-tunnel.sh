#!/bin/zsh
set -euo pipefail

if [[ ${1:-} == --help ]]; then
  printf '%s\n' 'Set AGENT_MAIL_CENTRAL_HOST to the private Central SSH target.' \
    'Load settings from ~/.config/joelclaw/tunnels.env or the process env.'
  exit 0
fi
tunnel_env="${JOELCLAW_TUNNELS_ENV_FILE:-$HOME/.config/joelclaw/tunnels.env}"
if [[ -r "$tunnel_env" ]]; then
  source "$tunnel_env"
fi

LOCAL_PORT="${AGENT_MAIL_LOCAL_PORT:-8765}"
CENTRAL_HOST="${AGENT_MAIL_CENTRAL_HOST:?set the private Central SSH target}"
if [[ "$CENTRAL_HOST" == -* ]]; then
  printf '%s\n' 'Invalid Central SSH target' >&2
  exit 2
fi
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
