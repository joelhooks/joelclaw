#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TEST_ROOT="$(mktemp -d /tmp/session-index-health-test.XXXXXX)"
export TEST_ROOT
mkdir -p "${TEST_ROOT}/bin" "${TEST_ROOT}/runs/joel/2026-07" "${TEST_ROOT}/state"
printf '%s\n' 'TYPESENSE_API_KEY=test-only' >"${TEST_ROOT}/typesense.env"
printf '%s\n' '{"started_at":2000000000000}' >"${TEST_ROOT}/runs/joel/2026-07/canary.metadata.json"
printf '%s\n' '{"hits":[{"document":{"started_at":1000000000000}}]}' >"${TEST_ROOT}/indexed.json"
printf '%s\n' '1' >"${TEST_ROOT}/fail-recovery"
printf '%s\n' '0' >"${TEST_ROOT}/fail-otel"
printf '%s\n' '0' >"${TEST_ROOT}/fail-inngest"

cat >"${TEST_ROOT}/bin/curl" <<'MOCK'
#!/bin/sh
case "$*" in
  *runs_dev/documents/search*) cat "${TEST_ROOT}/indexed.json" ;;
  *observability/emit*)
    printf '%s\n' otel >>"${TEST_ROOT}/otel-attempts.log"
    [ "$(cat "${TEST_ROOT}/fail-otel")" = "0" ]
    ;;
  *127.0.0.1:8288/health*) [ "$(cat "${TEST_ROOT}/fail-inngest")" = "0" ] ;;
  *) exit 0 ;;
esac
MOCK
cat >"${TEST_ROOT}/bin/launchctl" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >>"${TEST_ROOT}/launchctl.log"
[ "$(cat "${TEST_ROOT}/fail-recovery")" = "0" ]
MOCK
chmod +x "${TEST_ROOT}/bin/curl" "${TEST_ROOT}/bin/launchctl"

run_probe() {
  PATH="${TEST_ROOT}/bin:${PATH}" \
  STATE_DIR="${TEST_ROOT}/state" \
  RUNS_ROOT="${TEST_ROOT}/runs" \
  TYPESENSE_ENV="${TEST_ROOT}/typesense.env" \
  MAX_INDEX_LAG_SECONDS=300 \
  RECOVER_AFTER_FAILURES=3 \
  RECOVERY_COOLDOWN_SECONDS=900 \
  sh "${SCRIPT_DIR}/session-index-health.sh" >/dev/null 2>&1 || true
}

# index_lag_exceeded: recovery is scoped to the worker; the third failing probe
# attempts exactly one kick, and the cooldown stamps even though the kick fails,
# so later passes cannot re-kick until the cooldown expires (the 07-19 storm).
run_probe
run_probe
run_probe
[ "$(cat "${TEST_ROOT}/state/consecutive-failures")" = "3" ]
[ -s "${TEST_ROOT}/state/last-recovery-epoch" ]
[ "$(wc -l <"${TEST_ROOT}/launchctl.log" | tr -d ' ')" = "1" ]
grep -q 'gui/.*com.joel.system-bus-worker' "${TEST_ROOT}/launchctl.log"
! grep -q 'system/com.joelclaw.central.inngest' "${TEST_ROOT}/launchctl.log"

run_probe
[ "$(wc -l <"${TEST_ROOT}/launchctl.log" | tr -d ' ')" = "1" ]

# After the cooldown expires, a successful worker kick resets the failure count.
printf '%s\n' '1' >"${TEST_ROOT}/state/last-recovery-epoch"
printf '%s\n' '0' >"${TEST_ROOT}/fail-recovery"
run_probe
[ "$(cat "${TEST_ROOT}/state/consecutive-failures")" = "0" ]
[ "$(wc -l <"${TEST_ROOT}/launchctl.log" | tr -d ' ')" = "2" ]

run_probe
[ "$(wc -l <"${TEST_ROOT}/launchctl.log" | tr -d ' ')" = "2" ]

# A failed transition delivery stays pending. Once the worker accepts OTEL again,
# the pending state is delivered before the current state is considered emitted.
printf '%s\n' '{"hits":[{"document":{"started_at":2000000000000}}]}' >"${TEST_ROOT}/indexed.json"
printf '%s\n' '1' >"${TEST_ROOT}/fail-otel"
run_probe
[ -s "${TEST_ROOT}/state/pending-otel.json" ]
[ "$(cat "${TEST_ROOT}/state/last-emitted-status")" = "degraded:index_lag_exceeded" ]
printf '%s\n' '0' >"${TEST_ROOT}/fail-otel"
run_probe
[ ! -s "${TEST_ROOT}/state/pending-otel.json" ]
[ "$(cat "${TEST_ROOT}/state/last-emitted-status")" = "healthy:current" ]

# inngest_unavailable is the only reason that may restart the event server, and
# the recovery touches nothing else.
printf '%s\n' '1' >"${TEST_ROOT}/fail-inngest"
printf '%s\n' '1' >"${TEST_ROOT}/state/last-recovery-epoch"
run_probe
run_probe
run_probe
[ "$(cat "${TEST_ROOT}/state/consecutive-failures")" = "0" ]
[ "$(wc -l <"${TEST_ROOT}/launchctl.log" | tr -d ' ')" = "3" ]
[ "$(tail -n 1 "${TEST_ROOT}/launchctl.log")" = "kickstart -k system/com.joelclaw.central.inngest" ]
printf '%s\n' '0' >"${TEST_ROOT}/fail-inngest"

printf 'PASS session-index-health scoped recovery, stamped cooldown, retry, and OTEL delivery (%s)\n' "${TEST_ROOT}"
