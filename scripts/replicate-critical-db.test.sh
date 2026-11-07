#!/bin/sh
# macOS regression test: synthetic databases only, never live replicas/config.
set -eu
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
TEST_ROOT="$(mktemp -d -t critical-search-cache-test.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM
export HOME="$TEST_ROOT/home" XDG_STATE_HOME="$TEST_ROOT/state"
export CRITICAL_SEARCH_REPLICATION_CONFIG="$TEST_ROOT/no-config"
export CRITICAL_DB_SOURCE="$TEST_ROOT/source.db"
export CRITICAL_REPLICA_A_NAME=test-a CRITICAL_REPLICA_A_SSH=fake-a
export CRITICAL_REPLICA_A_ROOT=/synthetic/a
export CRITICAL_REPLICA_B_NAME=test-b CRITICAL_REPLICA_B_SSH=fake-b
export CRITICAL_REPLICA_B_ROOT=/synthetic/b
export HASH_LOG="$TEST_ROOT/hash.log" SSH_LOG="$TEST_ROOT/ssh.log"
export SSH_STATE_DIR="$TEST_ROOT/states"
REAL_SHASUM="$(command -v shasum)"
REAL_CP="$(command -v cp)"
export REAL_SHASUM REAL_CP
mkdir -p "$TEST_ROOT/bin" "$HOME" "$SSH_STATE_DIR"
: > "$HASH_LOG"
cat > "$TEST_ROOT/bin/shasum" <<'SH'
#!/bin/sh
set -eu
stat -f '%z' "$3" >> "$HASH_LOG"
"$REAL_SHASUM" "$@"
if [ "${REPLACE_DURING_HASH:-0}" = 1 ]; then
  mv "$CRITICAL_DB_SOURCE.next" "$CRITICAL_DB_SOURCE"
fi
SH
cat > "$TEST_ROOT/bin/cp" <<'SH'
#!/bin/sh
set -eu
"$REAL_CP" "$@"
if [ "${REPLACE_DURING_COPY:-0}" = 1 ]; then
  mv "$CRITICAL_DB_SOURCE.next" "$CRITICAL_DB_SOURCE"
fi
SH
cat > "$TEST_ROOT/bin/ssh" <<'SH'
#!/bin/sh
set -eu
printf '<%s> ' "$@" >> "$SSH_LOG"
printf '\n' >> "$SSH_LOG"
shift 4
host="$1"
command="$2"
case "$host" in fake-a|fake-b) ;; *) exit 99 ;; esac
case "$command" in
  *"cat >"*sync-state.json.incoming*) cat > "$SSH_STATE_DIR/$host.json" ;;
  *"cat >"*) cat > /dev/null ;;
esac
# Empty previous state, successful preflight and publish; no network calls.
exit 0
SH
chmod +x "$TEST_ROOT/bin/"*
export PATH="$TEST_ROOT/bin:$PATH"

make_db() {
  bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv[1]);
    db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)");
    db.query("INSERT INTO metadata VALUES (?, ?)").run("built_at", process.argv[2]);
    db.close();
  ' "$1" "$2"
}
CACHE_FILE="$XDG_STATE_HOME/joelclaw/critical-search-source.sha"
run_expect() {
  : > "$SSH_LOG"
  rm -f "$SSH_STATE_DIR/fake-a.json" "$SSH_STATE_DIR/fake-b.json"
  output="$(sh "$SCRIPT_DIR/replicate-critical-db.sh")"
  printf '%s\n' "$output" | grep -qx "source_sha=$1"
  printf '%s\n' "$output" | grep -q '^test-a copied=true '
  printf '%s\n' "$output" | grep -q '^test-b copied=true '
  [ "$(grep -c 'cat > .*sync-state.json.incoming' "$SSH_LOG")" -eq 2 ]
  python3 - "$SSH_STATE_DIR" <<'PY'
import datetime, json, pathlib, sys
for host, replica in [("fake-a", "test-a"), ("fake-b", "test-b")]:
    state = json.loads((pathlib.Path(sys.argv[1]) / f"{host}.json").read_text())
    checked = datetime.datetime.fromisoformat(state["checkedAt"].replace("Z", "+00:00"))
    assert abs((datetime.datetime.now(datetime.timezone.utc) - checked).total_seconds()) < 30
    assert state["replica"] == replica
    assert state["copiedThisRun"] is True
    assert len(state["sha256"]) == 64
PY
  calls="$(wc -l < "$HASH_LOG" | tr -d ' ')"
  [ "$calls" = "$2" ] || { echo "expected $2 hash calls, got $calls" >&2; exit 1; }
  printf 'PASS %s (hash calls=%s; both heartbeat uploads captured)\n' "$3" "$calls"
}

make_db "$CRITICAL_DB_SOURCE" '2026-01-01T00:00:00Z'
run_expect hashed 1 'first run'
[ "$(stat -f '%Lp' "$CACHE_FILE")" = 600 ]
first_bytes="$(awk '{sum += $1} END {print sum}' "$HASH_LOG")"
run_expect cached 1 'unchanged generation: zero checksum bytes read'
[ "$(awk '{sum += $1} END {print sum}' "$HASH_LOG")" = "$first_bytes" ]

# Same size and mtime: only the inode exposes this atomic publication.
make_db "$CRITICAL_DB_SOURCE.next" '2026-01-02T00:00:00Z'
touch -r "$CRITICAL_DB_SOURCE" "$CRITICAL_DB_SOURCE.next"
[ "$(stat -f '%z %Fm' "$CRITICAL_DB_SOURCE")" = "$(stat -f '%z %Fm' "$CRITICAL_DB_SOURCE.next")" ]
mv "$CRITICAL_DB_SOURCE.next" "$CRITICAL_DB_SOURCE"
run_expect hashed 2 'atomic replacement with same size/mtime'

inode="$(stat -f '%i' "$CRITICAL_DB_SOURCE")"
bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.env.CRITICAL_DB_SOURCE);
  db.exec("UPDATE metadata SET value = '\''2026-01-03T00:00:00Z'\''");
  db.close();
'
touch -t 202601030000 "$CRITICAL_DB_SOURCE"
[ "$(stat -f '%i' "$CRITICAL_DB_SOURCE")" = "$inode" ]
run_expect hashed 3 'in-place rewrite'
printf 'corrupt cache line\n' > "$CACHE_FILE"
run_expect hashed 4 'corrupt cache'
run_expect cached 4 'repaired cache'

# Neither a clone race nor a hash race may cache the wrong generation.
make_db "$CRITICAL_DB_SOURCE.next" '2026-01-04T00:00:00Z'
cp "$CACHE_FILE" "$TEST_ROOT/cache-before"
export REPLACE_DURING_COPY=1
run_expect hashed 5 'replacement during clone'
unset REPLACE_DURING_COPY
cmp "$CACHE_FILE" "$TEST_ROOT/cache-before"
run_expect hashed 6 'generation after clone race'

make_db "$CRITICAL_DB_SOURCE.next" '2026-01-05T00:00:00Z'
printf 'force a cache miss\n' > "$CACHE_FILE"
cp "$CACHE_FILE" "$TEST_ROOT/cache-before"
export REPLACE_DURING_HASH=1
run_expect hashed 7 'replacement during hash'
unset REPLACE_DURING_HASH
cmp "$CACHE_FILE" "$TEST_ROOT/cache-before"
run_expect hashed 8 'generation after hash race'
run_expect cached 8 'stable after races'
# A non-directory state root disables caching, not replication progress.
export XDG_STATE_HOME="$TEST_ROOT/blocked-state"
: > "$XDG_STATE_HOME"
run_expect hashed 9 'cache write failure remains nonfatal'
printf 'PASS checksum read volume: first=%s bytes; unchanged=0 bytes\n' "$first_bytes"
