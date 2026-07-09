#!/bin/bash
set -euo pipefail

TARGET_HOME="${HOME:-/Users/joel}"
PORT="${AGENT_MAIL_PORT:-8765}"
PREFERRED_CHECKOUT="${AGENT_MAIL_CHECKOUT:-${TARGET_HOME}/Code/joelhooks/mcp_agent_mail}"
LEGACY_CHECKOUT="${TARGET_HOME}/Code/Dicklesworthstone/mcp_agent_mail"

CHECKOUT=""
if [ -d "$PREFERRED_CHECKOUT" ]; then
  CHECKOUT="$PREFERRED_CHECKOUT"
elif [ -d "$LEGACY_CHECKOUT" ]; then
  CHECKOUT="$LEGACY_CHECKOUT"
else
  echo "agent-mail checkout not found; set AGENT_MAIL_CHECKOUT or clone joelhooks/mcp_agent_mail" >&2
  exit 1
fi

if [ -d "$CHECKOUT/.git" ]; then
  ORIGIN_URL="$(git -C "$CHECKOUT" remote get-url origin 2>/dev/null || true)"
  if [ -n "$ORIGIN_URL" ] && ! printf '%s' "$ORIGIN_URL" | grep -q 'joelhooks/mcp_agent_mail'; then
    echo "agent-mail checkout origin is not joelhooks/mcp_agent_mail: $ORIGIN_URL" >&2
    exit 1
  fi
fi

# launchd's default file descriptor soft limit is too low for git-backed
# multi-agent traffic. Keep this in the wrapper so the service survives even
# before the repo-managed plist is reinstalled.
ulimit -n "${AGENT_MAIL_NOFILE_LIMIT:-8192}" 2>/dev/null || \
  echo "warning: could not raise agent-mail file descriptor limit" >&2

UV_BIN="${UV_BIN:-}"
if [ -z "$UV_BIN" ]; then
  if [ -x "${TARGET_HOME}/.local/bin/uv" ]; then
    UV_BIN="${TARGET_HOME}/.local/bin/uv"
  elif command -v uv >/dev/null 2>&1; then
    UV_BIN="$(command -v uv)"
  elif [ -x "/opt/homebrew/bin/uv" ]; then
    UV_BIN="/opt/homebrew/bin/uv"
  else
    echo "uv not found; install uv or set UV_BIN" >&2
    exit 1
  fi
fi

exec "$UV_BIN" run --directory "$CHECKOUT" \
  python -c 'from mcp_agent_mail.cli import app; app()' -- \
  serve-http --port "$PORT"
