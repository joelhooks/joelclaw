#!/usr/bin/env bash
# Serial driver for resumable chunked imports into live Typesense.
# Safe to rerun — restore-jsonl.py checkpoints per collection+source.
#
# Env overrides:
#   TS_URL       (default: http://127.0.0.1:8108)
#   TS_KEY       (required or read from k8s/typesense.yaml)
#   SRC_URL      (default: http://127.0.0.1:18108)  — schema source
#   SRC_KEY      (default: recoverykey)
#   CACHE        (default: ~/.cache/typesense-transfer)
#   BATCH        (default: 500; docs_chunks_v2 forced to 100 to survive HNSW pressure)
#
# Usage:
#   import-all.sh                # all old collections in deterministic order
#   import-all.sh docs           # just one
#   import-all.sh docs system_knowledge
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESTORE="$SCRIPT_DIR/restore-jsonl.py"
TS_URL="${TS_URL:-http://127.0.0.1:8108}"
SRC_URL="${SRC_URL:-http://127.0.0.1:18108}"
SRC_KEY="${SRC_KEY:-recoverykey}"
CACHE="${CACHE:-$HOME/.cache/typesense-transfer}"
BATCH="${BATCH:-500}"

if [[ -z "${TS_KEY:-}" ]]; then
  TS_KEY=$(awk '/api-key:/ {gsub(/"/, "", $2); print $2; exit}' "$HOME/Code/joelhooks/joelclaw/k8s/typesense.yaml")
fi
if [[ -z "$TS_KEY" ]]; then
  echo "TS_KEY not set and not found in k8s/typesense.yaml" >&2
  exit 2
fi

# Order: smallest first so failures on cheap ones fail fast.
# docs_chunks_v2 + docs_chunks are big and run last with smaller batches.
DEFAULT_ORDER=(
  voice_transcripts
  transcripts
  blog_posts
  discoveries
  email_threads
  gateway_behavior_history
  docs
  slack_messages
  system_knowledge
  conversation_threads
  channel_messages
  system_log
  run_chunks_spike
  vault_notes
  pi_mono_artifacts
  memory_observations
  otel_events
  docs_chunks
  docs_chunks_v2
)

if [[ $# -gt 0 ]]; then
  ORDER=("$@")
else
  ORDER=("${DEFAULT_ORDER[@]}")
fi

for C in "${ORDER[@]}"; do
  SRC="$CACHE/${C}.old.jsonl"
  if [[ ! -f "$SRC" ]]; then
    echo "[skip] $C: no source at $SRC"
    continue
  fi
  B="$BATCH"
  if [[ "$C" == "docs_chunks_v2" ]]; then
    B=100  # large vector rows — smaller batch survives HNSW memory pressure
  fi
  echo "============================================================"
  echo "[import] collection=$C source=$SRC batch=$B"
  echo "============================================================"
  python3 "$RESTORE" \
    --url "$TS_URL" \
    --api-key "$TS_KEY" \
    --collection "$C" \
    --source "$SRC" \
    --schema-source-url "$SRC_URL" \
    --schema-source-key "$SRC_KEY" \
    --batch-size "$B" \
    --action emplace
done

echo "[done] all imports complete"
