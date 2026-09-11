#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPWIRE="$ROOT/infra/gateway-tripwire.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/gateway-tripwire-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FAKE_OSASCRIPT="$TMP/osascript"
cat > "$FAKE_OSASCRIPT" <<'SCRIPT'
#!/bin/bash
printf '%s\n' "$*" >> "$FAKE_NOTIFICATION_LOG"
if [ -f "$FAKE_OSASCRIPT_FAIL" ]; then
  exit 1
fi
SCRIPT
chmod +x "$FAKE_OSASCRIPT"

FAKE_INVESTIGATOR="$TMP/gateway-alert-investigator"
cat > "$FAKE_INVESTIGATOR" <<'SCRIPT'
#!/bin/bash
printf '%s\n' "$*" >> "$FAKE_INVESTIGATOR_LOG"
if [ "$1" = "recover" ] && [ -f "$FAKE_INVESTIGATOR_FAIL_RECOVER_ONCE" ]; then
  rm "$FAKE_INVESTIGATOR_FAIL_RECOVER_ONCE"
  exit 1
fi
if [ -f "$FAKE_INVESTIGATOR_FAIL" ]; then
  exit 1
fi
SCRIPT
chmod +x "$FAKE_INVESTIGATOR"

run_tripwire() {
  GATEWAY_HEARTBEAT_FILE="$TMP/heartbeat.ts" \
  GATEWAY_PID_FILE="$TMP/gateway.pid" \
  GATEWAY_TRIPWIRE_STATE_FILE="$TMP/tripwire.state" \
  GATEWAY_TRIPWIRE_THRESHOLD_SECONDS="${GATEWAY_TRIPWIRE_THRESHOLD_SECONDS:-1}" \
  GATEWAY_TRIPWIRE_OSASCRIPT_BIN="$FAKE_OSASCRIPT" \
  GATEWAY_ALERT_INVESTIGATOR_BIN="$FAKE_INVESTIGATOR" \
  FAKE_NOTIFICATION_LOG="$TMP/notifications.log" \
  FAKE_OSASCRIPT_FAIL="$TMP/osascript.fail" \
  FAKE_INVESTIGATOR_LOG="$TMP/investigator.log" \
  FAKE_INVESTIGATOR_FAIL="$TMP/investigator.fail" \
  FAKE_INVESTIGATOR_FAIL_RECOVER_ONCE="$TMP/investigator-recover-once.fail" \
    "$TRIPWIRE"
}

line_count() {
  if [ -f "$1" ]; then
    wc -l < "$1" | tr -d '[:space:]'
  else
    printf '0\n'
  fi
}

assert_eq() {
  if [ "$1" != "$2" ]; then
    printf 'expected %s, got %s\n' "$1" "$2" >&2
    exit 1
  fi
}

# Every unhealthy check reaches the investigator so its own state machine can
# retry failures. The investigator owns incident deduplication.
run_tripwire
run_tripwire
assert_eq 2 "$(line_count "$TMP/investigator.log")"
assert_eq 0 "$(line_count "$TMP/notifications.log")"
assert_eq missing "$(cat "$TMP/tripwire.state")"
assert_eq "alert missing" "$(head -1 "$TMP/investigator.log")"

# Recovery tells the active investigator to verify and leave a receipt.
printf 'export const lastHeartbeatTs = 1;\n' > "$TMP/heartbeat.ts"
run_tripwire
assert_eq 3 "$(line_count "$TMP/investigator.log")"
assert_eq "recover" "$(tail -1 "$TMP/investigator.log")"
assert_eq healthy "$(cat "$TMP/tripwire.state")"

# A later outage is a new incident after recovery.
rm "$TMP/heartbeat.ts"
run_tripwire
assert_eq 4 "$(line_count "$TMP/investigator.log")"
assert_eq "alert missing" "$(tail -1 "$TMP/investigator.log")"

# Sensor health stays truthful while the investigator keeps a failed recovery
# pending and retries it on the next healthy check.
printf 'export const lastHeartbeatTs = 1;\n' > "$TMP/heartbeat.ts"
touch "$TMP/investigator-recover-once.fail"
run_tripwire
assert_eq healthy "$(cat "$TMP/tripwire.state")"
run_tripwire
assert_eq healthy "$(cat "$TMP/tripwire.state")"
assert_eq 6 "$(line_count "$TMP/investigator.log")"

# Stale checks include the observed heartbeat age.
touch -t 200001010000 "$TMP/heartbeat.ts"
run_tripwire
run_tripwire
assert_eq 8 "$(line_count "$TMP/investigator.log")"
if ! tail -2 "$TMP/investigator.log" | grep -Eq '^alert stale [0-9]+$'; then
  echo "stale alert did not include heartbeat age" >&2
  exit 1
fi
assert_eq stale "$(cat "$TMP/tripwire.state")"

# A live, young gateway gets startup grace without dispatching an alert.
rm "$TMP/heartbeat.ts"
printf '%s\n' "$$" > "$TMP/gateway.pid"
printf 'healthy\n' > "$TMP/tripwire.state"
GATEWAY_TRIPWIRE_THRESHOLD_SECONDS=3600 run_tripwire
assert_eq 8 "$(line_count "$TMP/investigator.log")"
assert_eq starting "$(cat "$TMP/tripwire.state")"

# If the Herdr investigator cannot start, retain one edge-triggered native
# notification as the failure path rather than silently dropping the outage.
rm -f "$TMP/gateway.pid"
printf 'healthy\n' > "$TMP/tripwire.state"
touch "$TMP/investigator.fail"
run_tripwire
run_tripwire
assert_eq 1 "$(line_count "$TMP/notifications.log")"
assert_eq missing "$(cat "$TMP/tripwire.state")"

# A failed native notification is retried because its outage state was not committed.
printf 'healthy\n' > "$TMP/tripwire.state"
touch "$TMP/osascript.fail"
run_tripwire
assert_eq healthy "$(cat "$TMP/tripwire.state")"
assert_eq 2 "$(line_count "$TMP/notifications.log")"
rm "$TMP/osascript.fail"
run_tripwire
assert_eq missing "$(cat "$TMP/tripwire.state")"
assert_eq 3 "$(line_count "$TMP/notifications.log")"

printf 'PASS: gateway tripwire dispatches one deduplicated Herdr investigator\n'
