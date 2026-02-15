#!/bin/bash
set -euo pipefail

# Agent Loop Runner entrypoint
# Env vars:
#   REPO_URL     - HTTPS repo URL (e.g., https://github.com/owner/repo.git)
#   BRANCH       - Branch to checkout (e.g., agent-loop/abc123)
#   GITHUB_TOKEN - GitHub App installation token for auth
#   WORK_DIR     - Working directory inside container (default: /workspace/repo)

WORK_DIR="${WORK_DIR:-/workspace/repo}"

echo "🚀 Agent Loop Runner starting..."
echo "   Repo:   ${REPO_URL:-<not set>}"
echo "   Branch: ${BRANCH:-<not set>}"

# ── Clone repo with token auth ───────────────────────────────────────
if [ -n "${REPO_URL:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
  # Inject token into HTTPS URL: https://x-access-token:TOKEN@github.com/owner/repo.git
  AUTH_URL=$(echo "$REPO_URL" | sed "s|https://|https://x-access-token:${GITHUB_TOKEN}@|")

  echo "📦 Cloning repository..."
  git clone --depth 50 "$AUTH_URL" "$WORK_DIR" 2>&1

  cd "$WORK_DIR"

  # Configure git identity for commits
  git config user.name "joelclawgithub[bot]"
  git config user.email "joelclawgithub[bot]@users.noreply.github.com"

  # Checkout branch if specified
  if [ -n "${BRANCH:-}" ]; then
    echo "🌿 Checking out branch: $BRANCH"
    git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH"
  fi

  # Store token for push operations
  git config credential.helper "!f() { echo \"username=x-access-token\"; echo \"password=${GITHUB_TOKEN}\"; }; f"

  echo "✅ Repository ready at $WORK_DIR"
elif [ -n "${REPO_URL:-}" ]; then
  echo "⚠️  GITHUB_TOKEN not set, cloning without auth..."
  git clone --depth 50 "$REPO_URL" "$WORK_DIR" 2>&1
  cd "$WORK_DIR"
  git config user.name "joelclawgithub[bot]"
  git config user.email "joelclawgithub[bot]@users.noreply.github.com"
else
  echo "ℹ️  No REPO_URL set, using /workspace as working directory"
  cd /workspace
fi

# ── Install project dependencies if package.json exists ──────────────
if [ -f "package.json" ]; then
  echo "📦 Installing dependencies with bun..."
  bun install 2>&1
fi

# ── Execute the provided command ─────────────────────────────────────
if [ $# -gt 0 ]; then
  echo "🔧 Executing: $*"
  exec "$@"
else
  echo "ℹ️  No command provided. Container ready for interactive use."
  exec /bin/bash
fi
