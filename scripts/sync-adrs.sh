#!/bin/bash
# Sync ADRs from Vault to web content directory.
# Run via launchd (WatchPaths) or manually: ./scripts/sync-adrs.sh
#
# Copies ~/Vault/docs/decisions/*.md → apps/web/content/adrs/
# Commits and pushes if there are changes.

set -euo pipefail

VAULT_ADRS="$HOME/Vault/docs/decisions"
WEB_ADRS="$(dirname "$0")/../apps/web/content/adrs"
REPO_ROOT="$(dirname "$0")/.."

# Ensure target dir exists
mkdir -p "$WEB_ADRS"

# Sync — delete removed ADRs, copy new/updated ones
rsync -av --delete --include='*.md' --exclude='*' "$VAULT_ADRS/" "$WEB_ADRS/"

# Check if anything changed
cd "$REPO_ROOT"
if git diff --quiet apps/web/content/adrs/ && [ -z "$(git ls-files --others --exclude-standard apps/web/content/adrs/)" ]; then
  echo "No ADR changes to sync."
  exit 0
fi

# Commit and push
git add apps/web/content/adrs/
git commit -m "sync: ADRs from Vault $(date +%Y-%m-%d)"
git push

echo "ADRs synced and pushed."
