#!/bin/bash
# Worker startup — leases secrets from agent-secrets daemon, injects as env vars
# No tokens in plists or dotfiles. Everything goes through the encrypted daemon.
#
# Self-healing: pulls latest from monorepo and installs deps on every start.
# Both are fast no-ops when nothing changed. Prevents crash loops from
# missing dependencies after a commit lands in the monorepo.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Sync with monorepo origin
git -C "$REPO_ROOT" pull --ff-only --quiet 2>&1 || echo "WARNING: git pull failed" >&2

# Install deps (catches new packages added by loops)
cd "$REPO_ROOT" && bun install --silent 2>&1 || echo "WARNING: bun install failed" >&2

cd "$(dirname "$0")"

CLAUDE_TOKEN=$(secrets lease claude_oauth_token --ttl 24h --raw 2>/dev/null)
if [ -n "$CLAUDE_TOKEN" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN"
else
  echo "WARNING: Failed to lease claude_oauth_token from agent-secrets" >&2
fi

exec bun run src/serve.ts
