#!/usr/bin/env bash
set -uo pipefail

# Launchd uses no arguments and the environment defaults below. Interactive use
# must choose exactly one positional mode; runtime selection remains the
# JOELCLAW_CAPTURE_RUNTIMES environment variable.
cli_mode=""
if (( $# > 1 )); then
  printf '%s\n' '{"action":"memory.native_capture.sweep","success":false,"error":"arguments-invalid","usage":"capture-native-sessions.sh [dry-run|apply]"}' >&2
  exit 2
fi
if (( $# == 1 )); then
  case "$1" in
    dry-run|apply) cli_mode="$1" ;;
    *)
      printf '%s\n' '{"action":"memory.native_capture.sweep","success":false,"error":"arguments-invalid","usage":"capture-native-sessions.sh [dry-run|apply]"}' >&2
      exit 2
      ;;
  esac
fi

repo_root="${JOELCLAW_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
bun_bin="${BUN_BIN:-$(command -v bun || true)}"
central_url="${JOELCLAW_SESSION_CAPTURE_URL:-${JOELCLAW_CENTRAL_URL:-http://127.0.0.1:3111}}"
runtimes="${JOELCLAW_CAPTURE_RUNTIMES:-hook-outbox cursor grok}"
mode="${cli_mode:-${JOELCLAW_CAPTURE_MODE:-apply}}"
backfill="$repo_root/scripts/backfill-native-sessions.ts"
replay="$repo_root/scripts/replay-native-run-capture.ts"

if [[ "$mode" != "apply" && "$mode" != "dry-run" ]]; then
  printf '%s\n' '{"action":"memory.native_capture.sweep","success":false,"error":"config-invalid"}' >&2
  exit 2
fi

if [[ -z "$bun_bin" || ! -f "$backfill" || ! -f "$replay" ]]; then
  printf '%s\n' '{"action":"memory.native_capture.sweep","success":false,"error":"preflight-failed"}' >&2
  exit 1
fi

status=0
for runtime in $runtimes; do
  if [[ "$runtime" == "hook-outbox" ]]; then
    args=("$bun_bin" "$replay")
  else
    args=(
      "$bun_bin"
      "$backfill"
      --runtime "$runtime"
      --central-url "$central_url"
      --summary-only
    )
  fi
  if [[ "$mode" == "apply" ]]; then
    args+=(--apply)
  fi
  if [[ "$runtime" == "grok" && "${JOELCLAW_GROK_FILESYSTEM_FALLBACK:-0}" == "1" ]]; then
    args+=(--allow-grok-filesystem-fallback)
  fi

  if "${args[@]}"; then
    printf '{"action":"memory.native_capture.runtime","success":true,"metadata":{"runtime":"%s"}}\n' "$runtime"
  else
    # Keep sweeping. One broken native store must not hide every other runtime.
    printf '{"action":"memory.native_capture.runtime","success":false,"error":"runtime-failed","metadata":{"runtime":"%s"}}\n' "$runtime" >&2
    status=1
  fi
done

exit "$status"
