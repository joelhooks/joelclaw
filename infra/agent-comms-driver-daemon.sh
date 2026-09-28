#!/bin/bash
set -euo pipefail

export HOME="/Users/joel"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Source fleet env overrides (sets JOELCLAW_CENTRAL_URL, MESSAGE_EVENT_CONVEX_URL, etc.)
[ -f "$HOME/.config/system-bus.env" ] && set -a && . "$HOME/.config/system-bus.env" && set +a

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

# The gateway runs in the operator's default Herdr session under its own cswap
# session profile. It must never share the swapped default Claude login: a
# long-lived session refreshing that login writes stale one-time refresh tokens
# back over other accounts, and the system launch domain cannot read Keychain
# reliably. See docs/gateway.md "Claude login".
CSWAP_BIN="${CSWAP_BIN:-$HOME/.local/bin/cswap}"
[ -x "$CSWAP_BIN" ] || {
  echo "cswap is missing or not executable: $CSWAP_BIN" >&2
  exit 78
}
[ -n "${GATEWAY_CLAUDE_ACCOUNT:-}" ] || {
  echo "GATEWAY_CLAUDE_ACCOUNT must name the cswap slot dedicated to the gateway" >&2
  exit 78
}

export GATEWAY_AGENT_TARGET="📨 gateway loop"
export GATEWAY_HERDR_SESSION="${GATEWAY_HERDR_SESSION:-default}"
export GATEWAY_HERDR_WORKSPACE="[jc] gateway agent"
export GATEWAY_SUCCESSOR_BRIEF_PATH="$REPO_ROOT/.brain/tasks/gateway-session-boot.svx"
# --require-session refuses to fall back to the shared default login.
# --share-history keeps transcripts in ~/.claude/projects, where the driver
# reads session age.
export GATEWAY_SUCCESSOR_COMMAND="cd $(printf '%q' "$REPO_ROOT") && MESSAGE_EVENT_CONVEX_URL=http://127.0.0.1:3210 $(printf '%q' "$CSWAP_BIN") run $(printf '%q' "$GATEWAY_CLAUDE_ACCOUNT") --require-session --share-history -- --model claude-sonnet-4-6 --effort medium --plugin-dir prototypes/agent-comms-gateway/claude-plugin --agent joelclaw-gateway"

cd "$REPO_ROOT"
exec "$PNPM_BIN" --filter @joelclaw/agent-comms-driver start
