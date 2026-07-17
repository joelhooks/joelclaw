#!/usr/bin/env bash
set -euo pipefail

NAS_ROOT="${SELF_HEALING_NAS_HDD_ROOT:-/Volumes/three-body}"
ARCHIVE_ROOT="${SYSTEM_LOG_ARCHIVE_ROOT:-${NAS_ROOT}/backups/slog/archive}"
SOURCE="panda:~/Vault/system/system-log.jsonl"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT="${ARCHIVE_ROOT}/system-log-panda-${STAMP}.jsonl"
RECEIPT="${SNAPSHOT}.receipt.json"
TMP="$(mktemp -t panda-system-log.XXXXXX)"
trap 'rm -f "$TMP" "${SNAPSHOT}.partial" "${RECEIPT}.partial"' EXIT

if [[ ! -d "$NAS_ROOT" ]]; then
  echo "NAS root is unavailable: $NAS_ROOT" >&2
  exit 1
fi

mkdir -p "$ARCHIVE_ROOT"
scp "$SOURCE" "$TMP"
if [[ ! -s "$TMP" ]]; then
  echo "Panda system log copy is empty; refusing to archive" >&2
  exit 1
fi

DOC_COUNT="$(wc -l < "$TMP" | tr -d ' ')"
BYTES="$(wc -c < "$TMP" | tr -d ' ')"
SHA256="$(shasum -a 256 "$TMP" | awk '{print $1}')"
install -m 600 "$TMP" "${SNAPSHOT}.partial"
mv "${SNAPSHOT}.partial" "$SNAPSHOT"

cat > "${RECEIPT}.partial" <<EOF
{
  "ok": true,
  "source": "panda:~/Vault/system/system-log.jsonl",
  "snapshotPath": "${SNAPSHOT}",
  "archivedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "lineCount": ${DOC_COUNT},
  "bytes": ${BYTES},
  "sha256": "${SHA256}"
}
EOF
chmod 600 "${RECEIPT}.partial"
mv "${RECEIPT}.partial" "$RECEIPT"

printf 'Snapshot: %s\nReceipt: %s\nSHA-256: %s\nLines: %s\n' "$SNAPSHOT" "$RECEIPT" "$SHA256" "$DOC_COUNT"
