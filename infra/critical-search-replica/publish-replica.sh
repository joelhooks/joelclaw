#!/bin/sh
set -eu

DATA_DIR="$1"
INCOMING_DB="$2"
EXPECTED_SHA="$3"
SOURCE_VERSION="$4"
SOURCE_MTIME="$5"
INCOMING_STATE="$6"

mkdir -p "$DATA_DIR"
chmod 750 "$DATA_DIR"
LOCK_DIR="$DATA_DIR/.publish-lockdir"
OWNER_FILE="$LOCK_DIR/owner"
boot_id() {
  if [ -r /proc/sys/kernel/random/boot_id ]; then
    cat /proc/sys/kernel/random/boot_id
  else
    boot_value="$(sysctl -n kern.boottime 2>/dev/null || true)"
    [ -n "$boot_value" ] && printf '%s' "$boot_value" | tr -cd '0-9' || echo unknown-boot
  fi
}
process_start() {
  process_pid="$1"
  if [ -r "/proc/$process_pid/stat" ]; then
    awk '{print $22}' "/proc/$process_pid/stat"
  else
    ps -o lstart= -p "$process_pid" 2>/dev/null | tr -cd '[:alnum:]'
  fi
}
BOOT_ID="$(boot_id)"
PROCESS_START="$(process_start $$)"
OWNER="$BOOT_ID|$$|$PROCESS_START"
lock_is_stale() {
  [ -f "$OWNER_FILE" ] || return 1
  IFS='|' read -r owner_boot owner_pid owner_start < "$OWNER_FILE" || return 1
  [ "$owner_boot" = "$BOOT_ID" ] || return 0
  case "$owner_pid" in *[!0-9]*|'') return 0 ;; esac
  kill -0 "$owner_pid" 2>/dev/null || return 0
  live_start="$(process_start "$owner_pid")"
  [ "$live_start" != "$owner_start" ]
}

attempt=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  attempt="$((attempt + 1))"
  if lock_is_stale; then
    stale_lock="$LOCK_DIR.stale.$BOOT_ID.$$.$attempt"
    mv "$LOCK_DIR" "$stale_lock" 2>/dev/null || true
    continue
  fi
  [ "$attempt" -lt 15 ] || { echo "replica publish lock stayed held: $LOCK_DIR" >&2; exit 75; }
  sleep 1
done
printf '%s\n' "$OWNER" > "$OWNER_FILE"
release_lock() {
  current_owner="$(cat "$OWNER_FILE" 2>/dev/null || true)"
  if [ "$current_owner" = "$OWNER" ]; then
    rm -f "$OWNER_FILE"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap release_lock EXIT HUP INT TERM

if [ "$INCOMING_DB" != "-" ]; then
  ACTUAL_SHA="$(sha256sum "$INCOMING_DB" | awk '{print $1}')"
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || {
    echo "incoming checksum mismatch" >&2
    exit 1
  }
fi

CURRENT_VERSION="$(sed -n 's/.*"sourceVersion":"\([^"]*\)".*/\1/p' "$DATA_DIR/sync-state.json" 2>/dev/null || true)"
CURRENT_MTIME="$(sed -n 's/.*"sourceMtime":"\([^"]*\)".*/\1/p' "$DATA_DIR/sync-state.json" 2>/dev/null || true)"
CURRENT_SHA="$(sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p' "$DATA_DIR/sync-state.json" 2>/dev/null || true)"
if [ -z "$CURRENT_VERSION" ] && [ "$CURRENT_SHA" != "$EXPECTED_SHA" ]; then
  CURRENT_VERSION="$CURRENT_MTIME"
fi
if [ -n "$CURRENT_VERSION" ]; then
  NEWEST="$(printf '%s\n%s\n' "$CURRENT_VERSION" "$SOURCE_VERSION" | sort | tail -1)"
  if [ "$NEWEST" != "$SOURCE_VERSION" ]; then
    echo "skipped older snapshot source_version=$SOURCE_VERSION current=$CURRENT_VERSION"
    exit 3
  fi
  if [ "$CURRENT_VERSION" = "$SOURCE_VERSION" ] && [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" != "$EXPECTED_SHA" ]; then
    echo "refusing equal-version snapshot with different checksum" >&2
    exit 4
  fi
fi

if [ "$INCOMING_DB" != "-" ]; then
  chmod 640 "$INCOMING_DB"
  mv "$INCOMING_DB" "$DATA_DIR/critical.db"
fi
[ ! -f "$DATA_DIR/critical.db" ] || chmod 640 "$DATA_DIR/critical.db"
chmod 640 "$INCOMING_STATE"
mv "$INCOMING_STATE" "$DATA_DIR/sync-state.json"
echo "published source_version=$SOURCE_VERSION source_mtime=$SOURCE_MTIME sha256=$EXPECTED_SHA"
