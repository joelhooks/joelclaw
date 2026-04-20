#!/usr/bin/env bash
# Replay the post-rebuild live backup on top of restored old collections.
# Uses the same resumable chunked importer with emplace semantics so post-
# rebuild data overwrites any old row that shares an id. Schema files from
# the backup are used as the source-of-truth schema when a collection is
# missing entirely (e.g. runs_dev + run_chunks_dev born post-rebuild).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESTORE="$SCRIPT_DIR/restore-jsonl.py"
TS_URL="${TS_URL:-http://127.0.0.1:8108}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/typesense-live-pre-restore-20260419T192956}"
BATCH="${BATCH:-500}"

if [[ -z "${TS_KEY:-}" ]]; then
  TS_KEY=$(awk '/api-key:/ {gsub(/"/, "", $2); print $2; exit}' "$HOME/Code/joelhooks/joelclaw/k8s/typesense.yaml")
fi
if [[ -z "$TS_KEY" ]]; then
  echo "TS_KEY not set and not found in k8s/typesense.yaml" >&2
  exit 2
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "backup dir not found: $BACKUP_DIR" >&2
  exit 2
fi

# Deterministic order — smallest first. Collections listed here are those the
# post-rebuild live had before the restore started; emplace overlays them on
# top of old data keyed by document id.
ORDER=(
  run_chunks_spike
  run_chunks_dev
  runs_dev
  channel_messages
  conversation_threads
  system_knowledge
  otel_events
)

for C in "${ORDER[@]}"; do
  SRC="$BACKUP_DIR/${C}.jsonl"
  SCHEMA="$BACKUP_DIR/${C}.schema.json"
  if [[ ! -f "$SRC" ]]; then
    echo "[skip] $C: no jsonl at $SRC"
    continue
  fi
  if [[ ! -f "$SCHEMA" ]]; then
    echo "[warn] $C: no schema file at $SCHEMA — will rely on live collection already existing"
    SCHEMA_ARGS=()
  else
    SCHEMA_ARGS=(--schema-file "$SCHEMA")
  fi
  echo "============================================================"
  echo "[replay] collection=$C source=$SRC batch=$BATCH"
  echo "============================================================"
  python3 "$RESTORE" \
    --url "$TS_URL" \
    --api-key "$TS_KEY" \
    --collection "$C" \
    --source "$SRC" \
    --batch-size "$BATCH" \
    --action emplace \
    "${SCHEMA_ARGS[@]}"
done

echo "[done] backup replay complete"
