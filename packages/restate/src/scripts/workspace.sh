#!/bin/bash
# Quick workspace setup from pre-cloned repo cache.
# Usage: source workspace.sh [target-dir]
#
# Sets up a fresh git workspace by copying the cached repo (fast)
# and configuring git push auth from the mounted token.
#
# Available in DAG shell handlers via: source /app/packages/restate/src/scripts/workspace.sh

set -e

WORKSPACE="${1:-/tmp/workspace-$(date +%s)}"
REPO_CACHE="${JOELCLAW_REPO_CACHE:-/app/repo-cache}"
TOKEN_FILE="/root/.github-token"

if [ -d "$REPO_CACHE/.git" ]; then
  # Fast path: copy cached repo (~200ms vs clone ~3s)
  cp -a "$REPO_CACHE" "$WORKSPACE"
  cd "$WORKSPACE"
  git fetch origin main --depth 1 2>/dev/null
  git reset --hard origin/main 2>/dev/null
else
  # Fallback: full clone
  git clone --depth 1 https://github.com/joelhooks/joelclaw.git "$WORKSPACE" 2>/dev/null
  cd "$WORKSPACE"
fi

# Configure push auth
git config user.email "panda@joelclaw.com"
git config user.name "joelclaw-agent"
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE")
  git remote set-url origin "https://joelhooks:${TOKEN}@github.com/joelhooks/joelclaw.git"
fi

echo "$WORKSPACE"
