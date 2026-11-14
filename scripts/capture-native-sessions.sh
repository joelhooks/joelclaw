#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly BUN_BIN="${BUN_BIN:-bun}"
readonly NODE_BIN="${NODE_BIN:-node}"
readonly CENTRAL_URL="${JOELCLAW_SESSION_CAPTURE_URL:-${JOELCLAW_CENTRAL_URL:-http://127.0.0.1:3111}}"
readonly BACKFILL="$REPO_ROOT/scripts/backfill-native-sessions.ts"
readonly MODE="${1:---dry-run}"
readonly MAX_SESSIONS="${NATIVE_CAPTURE_MAX_SESSIONS:-1}"
readonly CURSOR_CLI_ROOT="${CURSOR_CLI_ROOT:-$HOME/.cursor/projects}"
readonly GROK_ROOT="${GROK_ROOT:-$HOME/.grok/sessions}"
readonly GROK_INDEX="${GROK_INDEX:-$HOME/.grok/session_search.sqlite}"
readonly OPENCODE_DATABASE="${OPENCODE_DATABASE_PATH:-$HOME/.local/share/opencode/opencode.db}"

case "$MODE" in
  --apply|--dry-run) ;;
  *) printf 'usage: %s [--dry-run|--apply]\n' "$0" >&2; exit 2 ;;
esac

if [[ "$MODE" == "--apply" ]]; then
  CAPTURE_PROBE_STATUS=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' --data '{}' "$CENTRAL_URL/api/runs")
  if [[ "$CAPTURE_PROBE_STATUS" != "401" ]]; then
    printf 'raw capture route probe expected 401, got %s\n' "$CAPTURE_PROBE_STATUS" >&2
    exit 1
  fi
fi

run_backfill() {
  local runtime="$1"
  shift
  if [[ "$MODE" == "--apply" ]]; then
    "$BUN_BIN" "$BACKFILL" --runtime "$runtime" "$@" \
      --central-url "$CENTRAL_URL" --limit "$MAX_SESSIONS" --apply --summary-only
  else
    "$BUN_BIN" "$BACKFILL" --runtime "$runtime" "$@" \
      --central-url "$CENTRAL_URL" --limit "$MAX_SESSIONS" --summary-only
  fi
}

# Opt in only after the operator reviews a dry count and two-window canary.
# Replay failure must not skip either existing native-store backfill.
REPLAY_STATUS=0
if [[ "${JOELCLAW_NATIVE_CAPTURE_REPLAY_ENABLED:-0}" == "1" ]]; then
  "$NODE_BIN" "$REPO_ROOT/scripts/replay-native-capture-outboxes.mjs" \
    "$MODE" --calls "${NATIVE_CAPTURE_REPLAY_CALLS:-1}" || REPLAY_STATUS=$?
fi

run_backfill cursor --cursor-cli-root "$CURSOR_CLI_ROOT"

if [[ "${JOELCLAW_GROK_FILESYSTEM_FALLBACK_ENABLED:-0}" == "1" ]]; then
  run_backfill grok --grok-root "$GROK_ROOT" --grok-index "$GROK_INDEX" \
    --allow-grok-filesystem-fallback
else
  run_backfill grok --grok-root "$GROK_ROOT" --grok-index "$GROK_INDEX"
fi

# OpenCode remains an explicit canary opt-in and is bounded to one session by default.
if [[ "${JOELCLAW_OPENCODE_RAW_SWEEP_ENABLED:-0}" == "1" ]]; then
  "$NODE_BIN" "$REPO_ROOT/scripts/capture-opencode-native-runs.mjs" \
    --database "$OPENCODE_DATABASE" \
    --max-sessions "$MAX_SESSIONS" \
    --central-url "$CENTRAL_URL" \
    "$MODE" \
    --summary-only
fi

exit "$REPLAY_STATUS"
