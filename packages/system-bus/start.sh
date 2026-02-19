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

# agent-secrets v0.5.0+: raw output is default (no --raw flag)
CLAUDE_TOKEN=$(secrets lease claude_oauth_token --ttl 24h 2>/dev/null)
if [ -n "$CLAUDE_TOKEN" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN"
else
  echo "WARNING: Failed to lease claude_oauth_token from agent-secrets" >&2
fi

# Webhook secrets
TODOIST_SECRET=$(secrets lease todoist_client_secret --ttl 24h 2>/dev/null)
if [ -n "$TODOIST_SECRET" ]; then
  export TODOIST_CLIENT_SECRET="$TODOIST_SECRET"
else
  echo "WARNING: Failed to lease todoist_client_secret" >&2
fi

TODOIST_TOKEN=$(secrets lease todoist_api_token --ttl 24h 2>/dev/null)
if [ -n "$TODOIST_TOKEN" ]; then
  export TODOIST_API_TOKEN="$TODOIST_TOKEN"
else
  echo "WARNING: Failed to lease todoist_api_token" >&2
fi

FRONT_SECRET=$(secrets lease front_rules_webhook_secret --ttl 24h 2>/dev/null)
if [ -n "$FRONT_SECRET" ]; then
  export FRONT_WEBHOOK_SECRET="$FRONT_SECRET"
else
  echo "WARNING: Failed to lease front_rules_webhook_secret" >&2
fi

exec bun run src/serve.ts
