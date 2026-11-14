#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
HEALTH_PLIST="${SCRIPT_DIR}/com.joelclaw.central.session-index-health.plist"
WORKER_PLIST="${SCRIPT_DIR}/../../launchd/com.joel.system-bus-worker.plist"

# The health probe has no UserName, so launchd runs it as root in the system
# domain. The worker is also a system LaunchDaemon; UserName only changes the
# worker process owner, not its launchctl domain.
! grep -q '<key>UserName</key>' "${HEALTH_PLIST}"
grep -q '<string>com.joel.system-bus-worker</string>' "${WORKER_PLIST}"

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/session-index-health-test.XXXXXX")"
export TEST_ROOT
mkdir -p "${TEST_ROOT}/bin" "${TEST_ROOT}/runs/joel/2026-07" "${TEST_ROOT}/state"
printf '%s\n' '{"captured_at":2000000000000}' >"${TEST_ROOT}/runs/joel/2026-07/canary.metadata.json"
python3 - "${TEST_ROOT}/runs/joel/2026-07" <<'PY'
import os, sys
os.utime(sys.argv[1], (2_000_000_000, 2_000_000_000))
PY
printf '%s\n' '1|1000000000000' >"${TEST_ROOT}/indexed.txt"
printf '%s\n' 'fixture' >"${TEST_ROOT}/sessions.db"
printf '%s\n' '1' >"${TEST_ROOT}/fail-recovery"
printf '%s\n' '0' >"${TEST_ROOT}/fail-otel"
printf '%s\n' '0' >"${TEST_ROOT}/fail-inngest"
printf '%s\n' '0' >"${TEST_ROOT}/fail-typesense"
printf '%s\n' '0' >"${TEST_ROOT}/worker-curl-rc"
printf '%s\n' '{"status":"running","count":1}' >"${TEST_ROOT}/worker-body.json"
printf 'api-key = test-key\n' >"${TEST_ROOT}/typesense.ini"

cat >"${TEST_ROOT}/bin/curl" <<'MOCK'
#!/bin/sh
case "$*" in
  *observability/emit*)
    printf '%s\n' otel >>"${TEST_ROOT}/otel-attempts.log"
    case "$*" in
      *"-H @${TEST_ROOT}/emit-token.header"*) printf '%s\n' header >>"${TEST_ROOT}/otel-headers.log" ;;
      *) printf '%s\n' noheader >>"${TEST_ROOT}/otel-headers.log" ;;
    esac
    [ "$(cat "${TEST_ROOT}/fail-otel")" = "0" ]
    ;;
  *127.0.0.1:8288/health*) [ "$(cat "${TEST_ROOT}/fail-inngest")" = "0" ] ;;
  *127.0.0.1:8108/collections*) [ "$(cat "${TEST_ROOT}/fail-typesense")" = "0" ] ;;
  */api/inngest*)
    # Unsigned SDK GETs fail during drain; this must never be our health probe.
    printf '%s\n' sdk-get >>"${TEST_ROOT}/sdk-gets.log"
    exit 22
    ;;
  */)
    cat "${TEST_ROOT}/worker-body.json"
    exit "$(cat "${TEST_ROOT}/worker-curl-rc")"
    ;;
  *) exit 0 ;;
esac
MOCK
cat >"${TEST_ROOT}/bin/sqlite3" <<'MOCK'
#!/bin/sh
cat "${TEST_ROOT}/indexed.txt"
MOCK
cat >"${TEST_ROOT}/bin/launchctl" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >>"${TEST_ROOT}/launchctl.log"
[ "$(cat "${TEST_ROOT}/fail-recovery")" = "0" ]
MOCK
chmod +x "${TEST_ROOT}/bin/curl" "${TEST_ROOT}/bin/launchctl" "${TEST_ROOT}/bin/sqlite3"

run_probe() {
  probe_rc=0
  PATH="${TEST_ROOT}/bin:${PATH}" \
  STATE_DIR="${TEST_ROOT}/state" \
  EMIT_TOKEN_HEADER_FILE="${TEST_ROOT}/emit-token.header" \
  RUNS_ROOT="${TEST_ROOT}/runs" \
  SESSION_INDEX_PATH="${TEST_ROOT}/sessions.db" \
  SQLITE3_BIN="${TEST_ROOT}/bin/sqlite3" \
  TYPESENSE_INI="${TEST_ROOT}/typesense.ini" \
  MAX_INDEX_LAG_SECONDS=300 \
  RECOVER_AFTER_FAILURES=3 \
  RECOVERY_COOLDOWN_SECONDS=900 \
  INDEX_PROGRESS_WINDOW_SECONDS=900 \
  sh "${SCRIPT_DIR}/session-index-health.sh" >>"${TEST_ROOT}/probe.log" 2>&1 || probe_rc=$?
}

kick_count() {
  wc -l <"${TEST_ROOT}/launchctl.log" | tr -d ' '
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
grep -q '^kickstart -k system/com.joel.system-bus-worker$' "${TEST_ROOT}/launchctl.log"
! grep -q 'system/com.joelclaw.central.inngest' "${TEST_ROOT}/launchctl.log"
! grep -q 'gui/' "${TEST_ROOT}/launchctl.log"

run_probe
[ "$(wc -l <"${TEST_ROOT}/launchctl.log" | tr -d ' ')" = "1" ]

# After the cooldown expires, a successful worker kick resets the failure count.
printf '%s\n' '1' >"${TEST_ROOT}/state/last-recovery-epoch"
printf '%s\n' '0' >"${TEST_ROOT}/fail-recovery"
run_probe
[ "$(cat "${TEST_ROOT}/state/consecutive-failures")" = "0" ]
[ "$(wc -l <"${TEST_ROOT}/launchctl.log" | tr -d ' ')" = "2" ]
[ "$(tail -n 1 "${TEST_ROOT}/launchctl.log")" = "kickstart -k system/com.joel.system-bus-worker" ]

run_probe
[ "$(wc -l <"${TEST_ROOT}/launchctl.log" | tr -d ' ')" = "2" ]

# A failed transition delivery stays pending. Once the worker accepts OTEL again,
# the pending state is delivered before the current state is considered emitted.
printf '%s\n' '1|2000000000000' >"${TEST_ROOT}/indexed.txt"
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

# typesense_unavailable restarts only Typesense. The 2026-08-07 wedge kept
# /health green while the authed data path timed out, so the probe failing
# must implicate Typesense itself, never Inngest or the worker.
printf '%s\n' '1' >"${TEST_ROOT}/fail-typesense"
printf '%s\n' '1' >"${TEST_ROOT}/state/last-recovery-epoch"
run_probe
run_probe
run_probe
[ "$(cat "${TEST_ROOT}/state/consecutive-failures")" = "0" ]
[ "$(wc -l <"${TEST_ROOT}/launchctl.log" | tr -d ' ')" = "4" ]
[ "$(tail -n 1 "${TEST_ROOT}/launchctl.log")" = "kickstart -k system/com.joelclaw.central.typesense" ]
printf '%s\n' '0' >"${TEST_ROOT}/fail-typesense"

# index_lag_exceeded under an Inngest backlog: the index lags but keeps
# advancing, so recovery is deferred and nothing is kicked (2026-10-07: the
# kick killed in-flight runs and deepened a 27h backlog). Failures keep counting.
printf '%s\n' '1' >"${TEST_ROOT}/state/last-recovery-epoch"
rm -f "${TEST_ROOT}/state/last-indexed-epoch" "${TEST_ROOT}/state/last-index-progress-epoch"
kicks_before="$(kick_count)"
: >"${TEST_ROOT}/probe.log"
for indexed_ms in 1000000000000 1000000060000 1000000120000 1000000180000 1000000240000; do
  printf '%s\n' "1|${indexed_ms}" >"${TEST_ROOT}/indexed.txt"
  run_probe
done
[ "$(kick_count)" = "${kicks_before}" ]
[ "$(cat "${TEST_ROOT}/state/consecutive-failures")" = "5" ]
grep -q 'recovery deferred (inngest backlog)' "${TEST_ROOT}/probe.log"
grep -q '"recoveryDeferred": true' "${TEST_ROOT}/state/latest.json"

# Truly stuck: the index stopped advancing longer than the window ago, so the
# next lagging pass kicks the worker immediately (failures are already past the
# threshold) and only the worker.
printf '%s\n' '1' >"${TEST_ROOT}/state/last-index-progress-epoch"
run_probe
[ "$(kick_count)" = "$((kicks_before + 1))" ]
[ "$(tail -n 1 "${TEST_ROOT}/launchctl.log")" = "kickstart -k system/com.joel.system-bus-worker" ]
grep -q '"recoveryDeferred": false' "${TEST_ROOT}/state/latest.json"

# A first observation with no recorded progress cannot defer, so a fresh
# install or wiped state still recovers a stuck index.
rm -f "${TEST_ROOT}/state/last-indexed-epoch" "${TEST_ROOT}/state/last-index-progress-epoch"
printf '%s\n' '1' >"${TEST_ROOT}/state/last-recovery-epoch"
printf '%s\n' '1|1000000300000' >"${TEST_ROOT}/indexed.txt"
printf '%s\n' '3' >"${TEST_ROOT}/state/consecutive-failures"
run_probe
[ "$(kick_count)" = "$((kicks_before + 2))" ]

# Emits carry the worker token from the header file once it is installed, and
# never without the file (sec-20261103-011).
grep -qx noheader "${TEST_ROOT}/otel-headers.log"
! grep -qx header "${TEST_ROOT}/otel-headers.log"
printf 'x-otel-emit-token: test\n' >"${TEST_ROOT}/emit-token.header"
printf '%s\n' '0' >"${TEST_ROOT}/fail-otel"
printf '%s\n' '{"probe":true}' >"${TEST_ROOT}/state/pending-otel.json"
printf '%s\n' 'degraded:index_lag_exceeded' >"${TEST_ROOT}/state/pending-otel-status"
run_probe
[ "$(tail -1 "${TEST_ROOT}/otel-headers.log")" = "header" ]

# Root worker health must pass only for a running worker with a positive numeric
# function count. All commands above and below use mocks, never live services.
printf '%s\n' '1|2000000000000' >"${TEST_ROOT}/indexed.txt"
assert_worker_probe() {
  expected_rc="$1"
  expected_reason="$2"
  run_probe
  [ "${probe_rc}" -eq "${expected_rc}" ]
  python3 - "${TEST_ROOT}/state/latest.json" "${expected_reason}" <<'PY'
import json, sys
with open(sys.argv[1]) as receipt:
    assert json.load(receipt)["reason"] == sys.argv[2]
PY
}

assert_worker_probe 0 current
printf '%s\n' '{"status":"running","count":0}' >"${TEST_ROOT}/worker-body.json"
assert_worker_probe 1 worker_unavailable
# curl -f returns 22 for HTTP 401, and 7 for connection refused. Even a valid
# body cannot turn a failed request into a healthy worker.
printf '%s\n' '{"status":"running","count":1}' >"${TEST_ROOT}/worker-body.json"
printf '%s\n' '22' >"${TEST_ROOT}/worker-curl-rc"
assert_worker_probe 1 worker_unavailable
printf '%s\n' '7' >"${TEST_ROOT}/worker-curl-rc"
assert_worker_probe 1 worker_unavailable
printf '%s\n' '0' >"${TEST_ROOT}/worker-curl-rc"
for body in \
  '{"status":"starting","count":1}' \
  '{"status":"running","count":-1}' \
  '{"status":"running","count":"1"}' \
  '{"status":"running","count":true}' \
  '{"status":"running"}' \
  '{"status":"running","count":Infinity}' \
  '[]' 'not-json' ''; do
  printf '%s\n' "${body}" >"${TEST_ROOT}/worker-body.json"
  assert_worker_probe 1 worker_unavailable
done
# Formatting and unrelated keys do not change the health contract.
printf '%s\n' '{ "count": 2, "extra": true, "status": "running" }' >"${TEST_ROOT}/worker-body.json"
assert_worker_probe 0 current
[ ! -s "${TEST_ROOT}/sdk-gets.log" ]

# Exercise the actual worker decision with only curl and grep on PATH. Other
# probe tasks already use Python, but worker availability must not depend on it.
worker_check="$(sed -n '/^worker_ok() {/,/^}/p' "${SCRIPT_DIR}/session-index-health.sh")"
[ -n "${worker_check}" ]
SHELL_BIN="$(command -v sh)"
mkdir -p "${TEST_ROOT}/minimal-bin"
ln -s "$(command -v grep)" "${TEST_ROOT}/minimal-bin/grep"
cat >"${TEST_ROOT}/minimal-bin/curl" <<'MOCK'
#!/bin/sh
printf '%s\n' "${WORKER_TEST_BODY}"
exit "${WORKER_TEST_CURL_RC}"
MOCK
chmod +x "${TEST_ROOT}/minimal-bin/curl"
assert_worker_without_python() {
  expected_rc="$1"
  worker_rc=0
  PATH="${TEST_ROOT}/minimal-bin" \
  WORKER_TEST_BODY="$2" \
  WORKER_TEST_CURL_RC="$3" \
  WORKER_URL="unused" \
  "${SHELL_BIN}" -c '
    if command -v python3 >/dev/null 2>&1; then exit 99; fi
    eval "$1"
    worker_ok
  ' sh "${worker_check}" || worker_rc=$?
  [ "${worker_rc}" -eq "${expected_rc}" ]
}
assert_worker_without_python 0 '{"status":"running","count":12}' 0
assert_worker_without_python 1 '{"status":"running","count":0}' 0
assert_worker_without_python 1 '{"status":"running","count":12}' 22
assert_worker_without_python 1 '{"status":"running","count":12}' 7
assert_worker_without_python 1 '<html>not JSON</html>' 0

printf 'PASS session-index-health recovery, cooldown, OTEL, backlog deferral, drain-safe worker health, and curl/grep-only PATH (running/count, zero, 401, connection refused, non-JSON) (%s)\n' "${TEST_ROOT}"
