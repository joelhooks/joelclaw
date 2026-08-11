#!/bin/bash
set -euo pipefail

export HOME="/Users/joel"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PNPM_BIN="${PNPM_BIN:-$HOME/.local/share/fnm/aliases/default/bin/pnpm}"
REPO_ROOT="${REPO_ROOT:-$HOME/Code/joelhooks/joelclaw}"

[ -x "$PNPM_BIN" ] || {
  echo "pnpm is missing or not executable: $PNPM_BIN" >&2
  exit 78
}
[ -f "$REPO_ROOT/.brain/tasks/gateway-session-boot.svx" ] || {
  echo "gateway successor brief is missing" >&2
  exit 78
}

export GATEWAY_AGENT_TARGET="📨 gateway loop"
export GATEWAY_HERDR_SESSION="system"
export GATEWAY_HERDR_WORKSPACE="[jc] gateway agent"
export GATEWAY_SUCCESSOR_BRIEF_PATH="$REPO_ROOT/.brain/tasks/gateway-session-boot.svx"

cd "$REPO_ROOT"
exec "$PNPM_BIN" --filter @joelclaw/agent-comms-driver start
