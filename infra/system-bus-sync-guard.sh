#!/bin/bash
set -euo pipefail

export PATH="/Users/joel/.bun/bin:/Users/joel/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO_ROOT="${JOELCLAW_REPO:-/Users/joel/Code/joelhooks/joelclaw}"
STATE_DIR="${HOME}/.local/state/system-bus-sync"
STATE_FILE="${STATE_DIR}/last-seen-main-sha"
LOCK_DIR="${STATE_DIR}/lock"
LOG_FILE="/tmp/system-bus-sync.log"

log() {
  local msg="$1"
  printf '%s [system-bus-sync] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$msg" | tee -a "$LOG_FILE" >/dev/null
}

mkdir -p "$STATE_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "lock busy; skipping"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

if [[ ! -d "$REPO_ROOT/.git" ]]; then
  log "repo missing: $REPO_ROOT"
  exit 1
fi

current_sha="$(git -C "$REPO_ROOT" rev-parse --verify HEAD 2>/dev/null || true)"
if [[ -z "$current_sha" ]]; then
  log "unable to resolve HEAD"
  exit 1
fi

previous_sha=""
if [[ -f "$STATE_FILE" ]]; then
  previous_sha="$(tr -d '[:space:]' < "$STATE_FILE")"
fi

if [[ -z "$previous_sha" ]]; then
  printf '%s\n' "$current_sha" > "$STATE_FILE"
  log "primed state at $current_sha; no restart"
  exit 0
fi

if [[ "$previous_sha" == "$current_sha" ]]; then
  log "no-op: sha unchanged ($current_sha)"
  exit 0
fi

if git -C "$REPO_ROOT" merge-base --is-ancestor "$previous_sha" "$current_sha" 2>/dev/null; then
  changed_files="$(git -C "$REPO_ROOT" diff --name-only "$previous_sha..$current_sha")"
else
  changed_files="$(git -C "$REPO_ROOT" diff --name-only "$current_sha~1..$current_sha" 2>/dev/null || true)"
  log "non-linear history from $previous_sha to $current_sha; fallback to HEAD~1"
fi

should_restart=0
match_reason=""
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  case "$file" in
    packages/*|package.json|pnpm-lock.yaml|bun.lock|bun.lockb|infra/worker-supervisor/*|infra/launchd/com.joel.system-bus-worker.plist|infra/launchd/com.joel.system-bus-sync.plist)
      should_restart=1
      match_reason="$file"
      break
      ;;
  esac
done <<< "$changed_files"

printf '%s\n' "$current_sha" > "$STATE_FILE"

if [[ "$should_restart" -eq 0 ]]; then
  log "skip restart: no worker-impacting changes between $previous_sha..$current_sha"
  exit 0
fi

log "restart-worker triggered by $match_reason ($previous_sha..$current_sha)"
if /Users/joel/.bun/bin/joelclaw inngest restart-worker --register >> "$LOG_FILE" 2>&1; then
  log "restart-worker completed"
  exit 0
fi

exit_code=$?
log "restart-worker failed exit=$exit_code"
exit "$exit_code"
