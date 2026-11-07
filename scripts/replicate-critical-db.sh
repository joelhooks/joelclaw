#!/bin/sh
set -eu

CONFIG_FILE="${CRITICAL_SEARCH_REPLICATION_CONFIG:-$HOME/.config/joelclaw/critical-search-replication.env}"
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

SOURCE_DB="${CRITICAL_DB_SOURCE:-$HOME/.joelclaw/search/critical.db}"
[ -f "$SOURCE_DB" ] || { echo "critical.db source missing: $SOURCE_DB" >&2; exit 1; }

# Freeze one source generation before reading its checksum and metadata. The
# builder atomically renames critical.db, so reading the live path twice can
# otherwise combine the old file's checksum with the new file's built_at.
SOURCE_SNAPSHOT="$(mktemp -t critical-search-source.XXXXXX)"
CACHE_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/joelclaw/critical-search-source.sha"
CACHE_TEMP=""
cleanup() {
  rm -f "$SOURCE_SNAPSHOT"
  [ -z "$CACHE_TEMP" ] || rm -f "$CACHE_TEMP"
}
trap cleanup EXIT HUP INT TERM
source_identity() {
  stat -f '%d %i %z %Fm' "$SOURCE_DB"
}
SOURCE_ID_BEFORE="$(source_identity)"
cp -c -p "$SOURCE_DB" "$SOURCE_SNAPSHOT" 2>/dev/null || cp -p "$SOURCE_DB" "$SOURCE_SNAPSHOT"
SOURCE_ID_AFTER="$(source_identity)"

CACHE_LINE="$(cat "$CACHE_FILE" 2>/dev/null || true)"
CACHED_SHA="${CACHE_LINE##* }"
case "$CACHED_SHA" in
  *[!0-9a-f]*|'') CACHED_SHA="" ;;
esac
if [ "$SOURCE_ID_BEFORE" = "$SOURCE_ID_AFTER" ] &&
   [ "${#CACHED_SHA}" -eq 64 ] &&
   [ "$CACHE_LINE" = "$SOURCE_ID_BEFORE $CACHED_SHA" ]; then
  SOURCE_SHA="$CACHED_SHA"
  echo 'source_sha=cached'
else
  SOURCE_SHA="$(shasum -a 256 "$SOURCE_SNAPSHOT" | awk '{print $1}')"
  echo 'source_sha=hashed'
  # Never associate a snapshot with a generation published during its copy/hash.
  if [ "$SOURCE_ID_BEFORE" = "$SOURCE_ID_AFTER" ] &&
     [ "$SOURCE_ID_BEFORE" = "$(source_identity)" ]; then
    # A cache write failure must not interrupt replica heartbeats.
    if mkdir -p "${CACHE_FILE%/*}" &&
       CACHE_TEMP="$(mktemp "${CACHE_FILE}.XXXXXX")" &&
       chmod 600 "$CACHE_TEMP" &&
       printf '%s %s\n' "$SOURCE_ID_BEFORE" "$SOURCE_SHA" > "$CACHE_TEMP" &&
       mv -f "$CACHE_TEMP" "$CACHE_FILE"; then
      CACHE_TEMP=""
    else
      echo 'source checksum cache write failed; continuing without cache' >&2
    fi
  fi
fi
SOURCE_VERSION="$(CRITICAL_DB_SOURCE="$SOURCE_SNAPSHOT" bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.env.CRITICAL_DB_SOURCE, { readonly: true });
  const row = db.query("SELECT value FROM metadata WHERE key = ?").get("built_at");
  db.close();
  if (!row?.value) process.exit(1);
  console.log(row.value);
')"
SOURCE_MTIME_EPOCH="$(stat -f '%m' "$SOURCE_SNAPSHOT")"
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
      "cat > '$remote_db'" < "$SOURCE_SNAPSHOT"
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
