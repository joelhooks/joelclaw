#!/bin/bash
# Worker startup — leases secrets from agent-secrets daemon, injects as env vars
# No tokens in plists or dotfiles. Everything goes through the encrypted daemon.
#
# ADR-0089: single-source deployment.
# Startup is immutable: no runtime git pull / bun install mutation.

export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.local/share/fnm/aliases/default/bin:$PATH"

NODE_LINK="$HOME/.local/bin/node"
FNM_DEFAULT_NODE="$HOME/.local/share/fnm/aliases/default/bin/node"

if [ ! -x "$NODE_LINK" ]; then
  NODE_SOURCE=""
  if [ -x "$FNM_DEFAULT_NODE" ]; then
    NODE_SOURCE="$FNM_DEFAULT_NODE"
  else
    NODE_SOURCE=$(ls -1 "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -n 1)
  fi

  if [ -n "$NODE_SOURCE" ] && [ -x "$NODE_SOURCE" ]; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$NODE_SOURCE" "$NODE_LINK"
  else
    echo "WARNING: No fnm-managed node binary found; pi subprocesses may fail" >&2
  fi
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEGACY_WORKER_ROOT="$HOME/Code/system-bus-worker"

if [[ "$REPO_ROOT" == "$LEGACY_WORKER_ROOT"* ]]; then
  echo "FATAL: legacy worker clone runtime blocked by ADR-0089" >&2
  echo "Expected start script: $HOME/Code/joelhooks/joelclaw/packages/system-bus/start.sh" >&2
  echo "Fix: reinstall launch agent from monorepo and restart worker" >&2
  exit 78
fi

cd "$(dirname "$0")"

# Default role during transition; cluster role can be set in deployment env.
export WORKER_ROLE="${WORKER_ROLE:-host}"

# Load shared worker env when available (event/signing keys, base URLs, etc).
if [ -f "$HOME/.config/system-bus.env" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$HOME/.config/system-bus.env"
  set +a
fi

MANIFEST_SYNC_SOURCE="${MANIFEST_ARCHIVE_MANIFEST_PATH:-$HOME/Documents/manifest.clean.jsonl}"
MANIFEST_SYNC_TARGET="${JOELCLAW_DOCS_MANIFEST_CACHE_PATH:-/tmp/manifest.clean.jsonl}"
if [ -f "$MANIFEST_SYNC_SOURCE" ]; then
  mkdir -p "$(dirname "$MANIFEST_SYNC_TARGET")" 2>/dev/null || true
  if cp -f "$MANIFEST_SYNC_SOURCE" "$MANIFEST_SYNC_TARGET"; then
    export MANIFEST_ARCHIVE_MANIFEST_PATH="$MANIFEST_SYNC_TARGET"
    echo "[manifest-sync] mirrored $MANIFEST_SYNC_SOURCE -> $MANIFEST_SYNC_TARGET"
  else
    echo "WARNING: manifest sync failed ($MANIFEST_SYNC_SOURCE -> $MANIFEST_SYNC_TARGET)" >&2
  fi
else
  echo "[manifest-sync] source not found: $MANIFEST_SYNC_SOURCE"
fi

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

FRONT_TOKEN=$(secrets lease front_api_token --ttl 24h 2>/dev/null)
if [ -n "$FRONT_TOKEN" ]; then
  export FRONT_API_TOKEN="$FRONT_TOKEN"
else
  echo "WARNING: Failed to lease front_api_token" >&2
fi

VERCEL_SECRET=$(secrets lease vercel_webhook_secret --ttl 24h 2>/dev/null)
if [ -n "$VERCEL_SECRET" ]; then
  export VERCEL_WEBHOOK_SECRET="$VERCEL_SECRET"
else
  echo "ERROR: Failed to lease vercel_webhook_secret (Vercel webhook verification disabled)" >&2
fi

# ── Pre-start cleanup: kill any orphaned bun on port 3111 ──
# This prevents EADDRINUSE when launchd restarts after a crash.
STALE_PID=$(/usr/sbin/lsof -ti :3111 2>/dev/null | head -1)
if [ -n "$STALE_PID" ]; then
  echo "Killing stale process $STALE_PID on port 3111" >&2
  kill -9 "$STALE_PID" 2>/dev/null
  sleep 1
fi

# ── Signal forwarding: propagate SIGTERM to bun child ──
# launchctl sends SIGTERM to this shell. Without forwarding, bun becomes
# an orphan holding port 3111 forever. This was the root cause of every
# "Unable to reach SDK URL" / EADDRINUSE failure.
cleanup() {
  if [ -n "$WORKER_PID" ]; then
    echo "Forwarding SIGTERM to worker PID $WORKER_PID" >&2
    kill -TERM "$WORKER_PID" 2>/dev/null
    # Give bun 5s to drain, then force-kill
    for i in 1 2 3 4 5; do
      kill -0 "$WORKER_PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$WORKER_PID" 2>/dev/null
  fi
  exit 0
}
trap cleanup SIGTERM SIGINT SIGHUP

# Start worker in background so we can trap signals
bun run src/serve.ts &
WORKER_PID=$!

# Wait for worker to bind, then PUT sync to prevent stale registry
sleep 5
curl -s -X PUT http://127.0.0.1:3111/api/inngest >/dev/null 2>&1 \
  && echo "Function registry synced" \
  || echo "WARNING: Inngest function sync failed" >&2

# Wait indefinitely — signals handled by trap
wait $WORKER_PID
