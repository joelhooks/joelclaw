#!/bin/sh
set -eu

CONFIG_FILE="${CRITICAL_SEARCH_REPLICATION_CONFIG:-$HOME/.config/joelclaw/critical-search-replication.env}"
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

SOURCE_DB="${CRITICAL_DB_SOURCE:-$HOME/.joelclaw/search/critical.db}"
[ -f "$SOURCE_DB" ] || { echo "critical.db source missing: $SOURCE_DB" >&2; exit 1; }

SOURCE_SHA="$(shasum -a 256 "$SOURCE_DB" | awk '{print $1}')"
SOURCE_VERSION="$(CRITICAL_DB_SOURCE="$SOURCE_DB" bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.env.CRITICAL_DB_SOURCE, { readonly: true });
  const row = db.query("SELECT value FROM metadata WHERE key = ?").get("built_at");
  db.close();
  if (!row?.value) process.exit(1);
  console.log(row.value);
')"
SOURCE_MTIME_EPOCH="$(stat -f '%m' "$SOURCE_DB")"
SOURCE_MTIME="$(date -u -r "$SOURCE_MTIME_EPOCH" '+%Y-%m-%dT%H:%M:%SZ')"
CHECKED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

replicate_one() {
  name="$1"
  host="$2"
  root="$3"
  started="$(date +%s)"

  ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
    "mkdir -p '$root/data' && chmod 750 '$root' '$root/data' && command -v sha256sum >/dev/null && test -x '$root/publish-replica.sh'"

  previous_state="$(ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
    "test -f '$root/data/critical.db' && cat '$root/data/sync-state.json' 2>/dev/null || true")"
  previous_sha="$(printf '%s' "$previous_state" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha256", ""))' 2>/dev/null || true)"
  previous_copied_at="$(printf '%s' "$previous_state" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("copiedAt", ""))' 2>/dev/null || true)"
  copied=false
  suffix="$$.$(printf '%s' "$SOURCE_SHA" | cut -c1-12)"
  remote_db="-"

  if [ "$previous_sha" != "$SOURCE_SHA" ]; then
    remote_db="$root/data/critical.db.incoming.$suffix"
    ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
      "cat > '$remote_db'" < "$SOURCE_DB"
    previous_copied_at="$CHECKED_AT"
    copied=true
  fi

  [ -n "$previous_copied_at" ] || previous_copied_at="$CHECKED_AT"
  duration="$(( $(date +%s) - started ))"
  state_file="$(mktemp -t critical-search-sync-state.XXXXXX)"
  python3 - "$name" "$CHECKED_AT" "$previous_copied_at" "$SOURCE_VERSION" "$SOURCE_MTIME" "$SOURCE_SHA" "$duration" "$copied" > "$state_file" <<'PY'
import json, sys
name, checked, copied_at, source_version, source_mtime, sha256, duration, copied = sys.argv[1:]
print(json.dumps({
    "replica": name,
    "checkedAt": checked,
    "copiedAt": copied_at,
    "sourceVersion": source_version,
    "sourceMtime": source_mtime,
    "sha256": sha256,
    "syncDurationSeconds": int(duration),
    "copiedThisRun": copied == "true",
}, separators=(",", ":")))
PY
  remote_state="$root/data/sync-state.json.incoming.$suffix"
  ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
    "cat > '$remote_state'" < "$state_file"
  rm -f "$state_file"

  set +e
  publish_output="$(ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
    "'$root/publish-replica.sh' '$root/data' '$remote_db' '$SOURCE_SHA' '$SOURCE_VERSION' '$SOURCE_MTIME' '$remote_state'" 2>&1)"
  publish_status="$?"
  set -e
  if [ "$publish_status" -eq 3 ]; then
    printf '%s publish_skipped=older_snapshot detail=%s\n' "$name" "$publish_output"
    return 0
  fi
  [ "$publish_status" -eq 0 ] || { echo "$name publish failed: $publish_output" >&2; return "$publish_status"; }
  printf '%s copied=%s duration_seconds=%s checked_at=%s\n' "$name" "$copied" "$duration" "$CHECKED_AT"
}

: "${CRITICAL_REPLICA_A_NAME:?set CRITICAL_REPLICA_A_NAME}"
: "${CRITICAL_REPLICA_A_SSH:?set CRITICAL_REPLICA_A_SSH}"
: "${CRITICAL_REPLICA_A_ROOT:?set CRITICAL_REPLICA_A_ROOT}"
: "${CRITICAL_REPLICA_B_NAME:?set CRITICAL_REPLICA_B_NAME}"
: "${CRITICAL_REPLICA_B_SSH:?set CRITICAL_REPLICA_B_SSH}"
: "${CRITICAL_REPLICA_B_ROOT:?set CRITICAL_REPLICA_B_ROOT}"

replicate_one "$CRITICAL_REPLICA_A_NAME" "$CRITICAL_REPLICA_A_SSH" "$CRITICAL_REPLICA_A_ROOT"
replicate_one "$CRITICAL_REPLICA_B_NAME" "$CRITICAL_REPLICA_B_SSH" "$CRITICAL_REPLICA_B_ROOT"
