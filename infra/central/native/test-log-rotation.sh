#!/bin/sh
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SCRATCH_BASE="${TMPDIR:-/private/tmp}"
TEST_ROOT="$(mktemp -d "${SCRATCH_BASE%/}/log-rotation-test.XXXXXX")"
export CENTRAL_ROOT="${TEST_ROOT}/central"
STATE_DIR="${TEST_ROOT}/state"
LOG_FILE="${TEST_ROOT}/fixture.log"
WRITER="${TEST_ROOT}/writer.sh"
mkdir -p "${STATE_DIR}"
ACTIVE_PIDS=""
stop_fixture_writers() {
  for active_pid in ${ACTIVE_PIDS}; do
    kill -TERM "${active_pid}" 2>/dev/null || true
  done
}
trap stop_fixture_writers EXIT HUP INT TERM

cat >"${WRITER}" <<'WRITER'
#!/bin/sh
log_file="$1"
sequence=0
while :; do
  printf '%08d\n' "${sequence}" >>"${log_file}"
  sequence=$((sequence + 1))
done
WRITER
chmod +x "${WRITER}"

"${WRITER}" "${LOG_FILE}" &
writer_pid=$!
ACTIVE_PIDS="${ACTIVE_PIDS} ${writer_pid}"
process_pattern="^/bin/sh ${WRITER} ${LOG_FILE}$"

attempt=0
while [ "${attempt}" -lt 200 ]; do
  if [ -f "${LOG_FILE}" ] && [ "$(stat -f %z "${LOG_FILE}")" -ge 131072 ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.01
done
[ -f "${LOG_FILE}" ]
[ "$(stat -f %z "${LOG_FILE}")" -ge 131072 ]

inode_before="$(stat -f %i "${LOG_FILE}")"
LOG_ROTATION_TEST_MODE=1 \
LOG_ROTATION_TEST_PROCESS_PATTERN="${process_pattern}" \
LOG_ROTATION_TEST_LOG="${LOG_FILE}" \
LOG_ROTATION_SERVICE_USER="$(id -un)" \
LOG_ROTATION_STATE_DIR="${STATE_DIR}" \
LOG_ROTATION_MAX_BYTES=65536 \
LOG_ROTATION_MAX_ARCHIVES=7 \
LOG_ROTATION_MAX_AGE_SECONDS=86400 \
  sh "${SCRIPT_DIR}/rotate-service-logs.sh"
inode_after="$(stat -f %i "${LOG_FILE}")"
[ "${inode_before}" = "${inode_after}" ]
kill -0 "${writer_pid}"

attempt=0
while [ "${attempt}" -lt 100 ]; do
  [ "$(stat -f %z "${LOG_FILE}")" -gt 0 ] && break
  attempt=$((attempt + 1))
  sleep 0.01
done
kill -TERM "${writer_pid}"
wait "${writer_pid}" 2>/dev/null || true

archive_max="$(awk 'length($0) == 8 && $0 ~ /^[0-9]+$/ { value=$0+0; if (!seen || value > max) max=value; seen=1 } END { if (seen) print max }' "${LOG_FILE}.0")"
live_min="$(awk 'length($0) == 8 && $0 ~ /^[0-9]+$/ { value=$0+0; if (!seen || value < min) min=value; seen=1 } END { if (seen) print min }' "${LOG_FILE}")"
[ -n "${archive_max}" ]
[ -n "${live_min}" ]
[ "${live_min}" -eq $((archive_max + 1)) ]

archive_count="$(find "${TEST_ROOT}" -maxdepth 1 -type f -name 'fixture.log.[0-9]*' | wc -l | tr -d ' ')"
[ "${archive_count}" -le 7 ]
state_epoch="${STATE_DIR}/fixture-fixture.log.epoch"
[ -s "${state_epoch}" ]

# Force eight age rotations with a live writer. The same inode and PID survive,
# and retention never exceeds seven archives.
"${WRITER}" "${LOG_FILE}" &
age_writer_pid=$!
ACTIVE_PIDS="${ACTIVE_PIDS} ${age_writer_pid}"
age_process_pattern="^/bin/sh ${WRITER} ${LOG_FILE}$"
age_inode="$(stat -f %i "${LOG_FILE}")"
age_round=0
while [ "${age_round}" -lt 8 ]; do
  printf '%s\n' 1 >"${state_epoch}"
  LOG_ROTATION_TEST_MODE=1 \
  LOG_ROTATION_TEST_PROCESS_PATTERN="${age_process_pattern}" \
  LOG_ROTATION_TEST_LOG="${LOG_FILE}" \
  LOG_ROTATION_SERVICE_USER="$(id -un)" \
  LOG_ROTATION_STATE_DIR="${STATE_DIR}" \
  LOG_ROTATION_MAX_BYTES=1073741824 \
  LOG_ROTATION_MAX_ARCHIVES=7 \
  LOG_ROTATION_MAX_AGE_SECONDS=1 \
    sh "${SCRIPT_DIR}/rotate-service-logs.sh"
  kill -0 "${age_writer_pid}"
  [ "$(stat -f %i "${LOG_FILE}")" = "${age_inode}" ]
  age_round=$((age_round + 1))
done
kill -TERM "${age_writer_pid}"
wait "${age_writer_pid}" 2>/dev/null || true
archive_count="$(find "${TEST_ROOT}" -maxdepth 1 -type f -name 'fixture.log.[0-9]*' | wc -l | tr -d ' ')"
[ "${archive_count}" -eq 7 ]
[ -s "${LOG_FILE}.0" ]

# Measure a complete 64 MiB retained copy. This is the production threshold,
# not the small sequence fixture above.
FULL_LOG="${TEST_ROOT}/full-64m.log"
FULL_STATE="${TEST_ROOT}/full-state"
mkdir -p "${FULL_STATE}"
dd if=/dev/zero of="${FULL_LOG}" bs=1048576 count=64 2>/dev/null
"${WRITER}" "${FULL_LOG}" &
full_writer_pid=$!
ACTIVE_PIDS="${ACTIVE_PIDS} ${full_writer_pid}"
full_process_pattern="^/bin/sh ${WRITER} ${FULL_LOG}$"
full_inode="$(stat -f %i "${FULL_LOG}")"
LOG_ROTATION_TEST_MODE=1 \
LOG_ROTATION_TEST_PROCESS_PATTERN="${full_process_pattern}" \
LOG_ROTATION_TEST_LOG="${FULL_LOG}" \
LOG_ROTATION_SERVICE_USER="$(id -un)" \
LOG_ROTATION_STATE_DIR="${FULL_STATE}" \
LOG_ROTATION_MAX_BYTES=67108864 \
LOG_ROTATION_MAX_ARCHIVES=7 \
LOG_ROTATION_MAX_AGE_SECONDS=86400 \
LOG_ROTATION_MAX_PAUSE_MS=500 \
  sh "${SCRIPT_DIR}/rotate-service-logs.sh" 2>"${TEST_ROOT}/full-rotation.stderr"
kill -0 "${full_writer_pid}"
[ "$(stat -f %i "${FULL_LOG}")" = "${full_inode}" ]
[ "$(stat -f %z "${FULL_LOG}.0")" -eq 67108864 ]
attempt=0
while [ "${attempt}" -lt 100 ]; do
  [ "$(stat -f %z "${FULL_LOG}")" -gt 0 ] && break
  attempt=$((attempt + 1))
  sleep 0.01
done
kill -TERM "${full_writer_pid}"
wait "${full_writer_pid}" 2>/dev/null || true
IFS='|' read -r pause_epoch pause_pid full_pause_ms pause_service <"${FULL_STATE}/last-pause.latest"
[ "${pause_pid}" = "${full_writer_pid}" ]
[ "${pause_service}" = "fixture" ]
[ "${full_pause_ms}" -gt 0 ]
[ "${full_pause_ms}" -lt 500 ]
grep -q "pause_ms=${full_pause_ms}" "${TEST_ROOT}/full-rotation.stderr"

# Prove the production guard fails closed. An intentionally impossible
# 1 ms budget must resume the writer without truncating the live inode.
dd if=/dev/zero of="${FULL_LOG}" bs=1048576 count=64 2>/dev/null
"${WRITER}" "${FULL_LOG}" &
guard_writer_pid=$!
ACTIVE_PIDS="${ACTIVE_PIDS} ${guard_writer_pid}"
guard_process_pattern="^/bin/sh ${WRITER} ${FULL_LOG}$"
guard_inode="$(stat -f %i "${FULL_LOG}")"
guard_failure="${TEST_ROOT}/pause-budget-failure.log"
if LOG_ROTATION_TEST_MODE=1 \
  LOG_ROTATION_TEST_PROCESS_PATTERN="${guard_process_pattern}" \
  LOG_ROTATION_TEST_LOG="${FULL_LOG}" \
  LOG_ROTATION_SERVICE_USER="$(id -un)" \
  LOG_ROTATION_STATE_DIR="${FULL_STATE}" \
  LOG_ROTATION_MAX_BYTES=67108864 \
  LOG_ROTATION_MAX_ARCHIVES=7 \
  LOG_ROTATION_MAX_AGE_SECONDS=86400 \
  LOG_ROTATION_MAX_PAUSE_MS=1 \
    sh "${SCRIPT_DIR}/rotate-service-logs.sh" >"${guard_failure}" 2>&1; then
  printf 'FAIL rotator ignored the pause budget\n' >&2
  exit 1
fi
kill -0 "${guard_writer_pid}"
[ "$(stat -f %i "${FULL_LOG}")" = "${guard_inode}" ]
[ "$(stat -f %z "${FULL_LOG}")" -ge 67108864 ]
grep -q 'budget.*exceeded\|outside pause budget' "${guard_failure}"
kill -TERM "${guard_writer_pid}"
wait "${guard_writer_pid}" 2>/dev/null || true

# Reproduce the installed stall: a pre-truncate snapshot and legacy manifest
# must be reclaimed by the script, then rotation must complete on the retry.
RECOVERY_ROOT="${TEST_ROOT}/recovery"
RECOVERY_STATE="${RECOVERY_ROOT}/state"
RECOVERY_LOG="${RECOVERY_ROOT}/fixture.log"
mkdir -p "${RECOVERY_STATE}"
printf '%0131072d\n' 1 >"${RECOVERY_LOG}"
"${WRITER}" "${RECOVERY_LOG}" &
recovery_writer_pid=$!
ACTIVE_PIDS="${ACTIVE_PIDS} ${recovery_writer_pid}"
recovery_pattern="^/bin/sh ${WRITER} ${RECOVERY_LOG}$"
recovery_inode="$(stat -f %i "${RECOVERY_LOG}")"
recovery_size="$(stat -f %z "${RECOVERY_LOG}")"
cp -c "${RECOVERY_LOG}" "${RECOVERY_LOG}.snapshot.pending"
printf 'fixture|%s|%s|%s|%s\n' \
  "${RECOVERY_LOG}" "${RECOVERY_LOG}.snapshot.pending" "${recovery_inode}" "${recovery_size}" \
  >"${RECOVERY_STATE}/fixture-manifest"
LOG_ROTATION_TEST_MODE=1 \
LOG_ROTATION_TEST_PROCESS_PATTERN="${recovery_pattern}" \
LOG_ROTATION_TEST_LOG="${RECOVERY_LOG}" \
LOG_ROTATION_SERVICE_USER="$(id -un)" \
LOG_ROTATION_STATE_DIR="${RECOVERY_STATE}" \
LOG_ROTATION_MAX_BYTES=65536 \
LOG_ROTATION_MAX_ARCHIVES=7 \
LOG_ROTATION_MAX_AGE_SECONDS=86400 \
  sh "${SCRIPT_DIR}/rotate-service-logs.sh" 2>"${RECOVERY_ROOT}/rotation.stderr"
kill -0 "${recovery_writer_pid}"
[ -f "${RECOVERY_LOG}.0" ]
[ ! -e "${RECOVERY_LOG}.snapshot.pending" ]
[ ! -s "${RECOVERY_STATE}/fixture-manifest" ]
[ ! -s "${RECOVERY_STATE}/fixture-phase" ]
[ ! -s "${RECOVERY_STATE}/fixture-fixture.log.reclaimed" ]
grep -q 'reclaimed stale pre-truncate snapshot' "${RECOVERY_ROOT}/rotation.stderr"
kill -TERM "${recovery_writer_pid}"
wait "${recovery_writer_pid}" 2>/dev/null || true

# A missing writer must fail the rotator. This guards against shell constructs
# that accidentally swallow an internal error and return a false PASS.
printf '%s\n' 1 >"${state_epoch}"
expected_failure="${TEST_ROOT}/expected-failure.log"
if LOG_ROTATION_TEST_MODE=1 \
  LOG_ROTATION_TEST_PROCESS_PATTERN='^no-such-log-writer$' \
  LOG_ROTATION_TEST_LOG="${LOG_FILE}" \
  LOG_ROTATION_SERVICE_USER="$(id -un)" \
  LOG_ROTATION_STATE_DIR="${STATE_DIR}" \
  LOG_ROTATION_MAX_BYTES=1073741824 \
  LOG_ROTATION_MAX_ARCHIVES=7 \
  LOG_ROTATION_MAX_AGE_SECONDS=1 \
    sh "${SCRIPT_DIR}/rotate-service-logs.sh" >"${expected_failure}" 2>&1; then
  printf 'FAIL rotator returned success for a missing writer\n' >&2
  exit 1
fi
grep -q 'expected one .* writer.* found 0' "${expected_failure}"

# The daemon's own launchd logs are visible and bounded without inode replacement.
OWN_ROOT="${TEST_ROOT}/own-log"
OWN_STATE="${OWN_ROOT}/state"
OWN_FIXTURE="${OWN_ROOT}/fixture.log"
mkdir -p "${OWN_STATE}" "${OWN_ROOT}/logs/log-rotation"
dd if=/dev/zero of="${OWN_ROOT}/logs/log-rotation/stdout.log" bs=4096 count=1 2>/dev/null
dd if=/dev/zero of="${OWN_ROOT}/logs/log-rotation/stderr.log" bs=4096 count=1 2>/dev/null
stdout_inode="$(stat -f %i "${OWN_ROOT}/logs/log-rotation/stdout.log")"
stderr_inode="$(stat -f %i "${OWN_ROOT}/logs/log-rotation/stderr.log")"
printf '%02048d\n' 1 >"${OWN_FIXTURE}"
"${WRITER}" "${OWN_FIXTURE}" &
own_writer_pid=$!
ACTIVE_PIDS="${ACTIVE_PIDS} ${own_writer_pid}"
own_pattern="^/bin/sh ${WRITER} ${OWN_FIXTURE}$"
CENTRAL_ROOT="${OWN_ROOT}" \
LOG_ROTATION_TEST_MODE=1 \
LOG_ROTATION_TEST_PROCESS_PATTERN="${own_pattern}" \
LOG_ROTATION_TEST_LOG="${OWN_FIXTURE}" \
LOG_ROTATION_SERVICE_USER="$(id -un)" \
LOG_ROTATION_STATE_DIR="${OWN_STATE}" \
LOG_ROTATION_MAX_BYTES=1024 \
LOG_ROTATION_MAX_ARCHIVES=7 \
LOG_ROTATION_MAX_AGE_SECONDS=86400 \
LOG_ROTATION_OWN_LOG_MAX_BYTES=1024 \
  sh "${SCRIPT_DIR}/rotate-service-logs.sh"
kill -0 "${own_writer_pid}"
[ "$(stat -f %i "${OWN_ROOT}/logs/log-rotation/stdout.log")" = "${stdout_inode}" ]
[ "$(stat -f %i "${OWN_ROOT}/logs/log-rotation/stderr.log")" = "${stderr_inode}" ]
[ "$(stat -f %z "${OWN_ROOT}/logs/log-rotation/stdout.log")" -le 1024 ]
[ "$(stat -f %z "${OWN_ROOT}/logs/log-rotation/stderr.log")" -le 1280 ]
kill -TERM "${own_writer_pid}"
wait "${own_writer_pid}" 2>/dev/null || true

printf 'PASS log rotation preserved inode, process, sequence, age trigger, retention, pause budget, stale-snapshot recovery, own-log bounds, and failure propagation\n'
printf 'scratch=%s pid=%s inode=%s archive_max=%s live_min=%s archives=%s full_copy_bytes=67108864 pause_ms=%s budget_ms=500\n' \
  "${TEST_ROOT}" "${writer_pid}" "${inode_after}" "${archive_max}" "${live_min}" "${archive_count}" "${full_pause_ms}"
