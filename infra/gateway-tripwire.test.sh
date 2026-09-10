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
SCRIPT
chmod +x "$FAKE_OSASCRIPT"

run_tripwire() {
  GATEWAY_HEARTBEAT_FILE="$TMP/heartbeat.ts" \
  GATEWAY_PID_FILE="$TMP/gateway.pid" \
  GATEWAY_TRIPWIRE_STATE_FILE="$TMP/tripwire.state" \
  GATEWAY_TRIPWIRE_THRESHOLD_SECONDS="${GATEWAY_TRIPWIRE_THRESHOLD_SECONDS:-1}" \
  GATEWAY_TRIPWIRE_OSASCRIPT_BIN="$FAKE_OSASCRIPT" \
  FAKE_NOTIFICATION_LOG="$TMP/notifications.log" \
    "$TRIPWIRE"
}

notification_count() {
  if [ -f "$TMP/notifications.log" ]; then
    wc -l < "$TMP/notifications.log" | tr -d '[:space:]'
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

# One prolonged missing-file outage emits one notification, not one every run.
run_tripwire
run_tripwire
assert_eq 1 "$(notification_count)"
assert_eq missing "$(cat "$TMP/tripwire.state")"

# Recovery rearms the next outage.
printf 'export const lastHeartbeatTs = 1;\n' > "$TMP/heartbeat.ts"
run_tripwire
assert_eq healthy "$(cat "$TMP/tripwire.state")"
rm "$TMP/heartbeat.ts"
run_tripwire
assert_eq 2 "$(notification_count)"

# A stale heartbeat is its own alert state and is also deduplicated.
printf 'export const lastHeartbeatTs = 1;\n' > "$TMP/heartbeat.ts"
touch -t 200001010000 "$TMP/heartbeat.ts"
run_tripwire
run_tripwire
assert_eq 3 "$(notification_count)"
assert_eq stale "$(cat "$TMP/tripwire.state")"

# A live, young gateway gets startup grace without a notification.
rm "$TMP/heartbeat.ts"
printf '%s\n' "$$" > "$TMP/gateway.pid"
printf 'healthy\n' > "$TMP/tripwire.state"
GATEWAY_TRIPWIRE_THRESHOLD_SECONDS=3600 run_tripwire
assert_eq 3 "$(notification_count)"
assert_eq starting "$(cat "$TMP/tripwire.state")"

printf 'PASS: gateway tripwire notifications are edge-triggered\n'
