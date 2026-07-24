#!/bin/sh
set -eu

CENTRAL_ROOT="${CENTRAL_ROOT:-/Users/Shared/joelclaw}"
STATE_DIR="${LOG_ROTATION_STATE_DIR:-${CENTRAL_ROOT}/state/log-rotation}"
SERVICE_USER="${LOG_ROTATION_SERVICE_USER:-joelclaw}"
MAX_BYTES="${LOG_ROTATION_MAX_BYTES:-67108864}"
MAX_ARCHIVES="${LOG_ROTATION_MAX_ARCHIVES:-7}"
MAX_AGE_SECONDS="${LOG_ROTATION_MAX_AGE_SECONDS:-86400}"
MAX_PAUSE_MS="${LOG_ROTATION_MAX_PAUSE_MS:-500}"
LOCK_DIR="${STATE_DIR}/lock"
LOGGER_TAG="com.joelclaw.central.log-rotation"
STOPPED_PID=""
STOPPED_SERVICE=""
PAUSE_STARTED_MS=""
ROTATED_SUMMARY=""

log_notice() {
  /usr/bin/logger -t "${LOGGER_TAG}" -- "$*" 2>/dev/null || true
}

fail() {
  log_notice "ERROR $*"
  printf '%s\n' "$*" >&2
  return 1
}

milliseconds_now() {
  /usr/bin/perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000'
}

pause_elapsed_ms() {
  current_ms="$(milliseconds_now)"
  printf '%s\n' $((current_ms - PAUSE_STARTED_MS))
}

resume_writer() {
  if [ -n "${STOPPED_PID}" ]; then
    resumed_pid="${STOPPED_PID}"
    resumed_service="${STOPPED_SERVICE}"
    kill -CONT "${resumed_pid}" 2>/dev/null || true
    pause_ended_ms="$(milliseconds_now)"
    pause_duration_ms=$((pause_ended_ms - PAUSE_STARTED_MS))
    STOPPED_PID=""
    STOPPED_SERVICE=""
    PAUSE_STARTED_MS=""
    pause_tmp="$(mktemp "${STATE_DIR}/last-pause.XXXXXX")"
    printf '%s|%s|%s|%s\n' "$(date +%s)" "${resumed_pid}" "${pause_duration_ms}" "${resumed_service}" >"${pause_tmp}"
    mv "${pause_tmp}" "${STATE_DIR}/last-pause.latest"
    log_notice "resumed ${resumed_service} writer ${resumed_pid}; pause_ms=${pause_duration_ms}"
    printf 'resumed %s writer %s; pause_ms=%s\n' "${resumed_service}" "${resumed_pid}" "${pause_duration_ms}" >&2
  fi
}

release_lock() {
  resume_writer
  rmdir "${LOCK_DIR}" 2>/dev/null || true
}

trap release_lock EXIT HUP INT TERM

case "${MAX_BYTES}:${MAX_ARCHIVES}:${MAX_AGE_SECONDS}:${MAX_PAUSE_MS}" in
  *[!0-9:]*|0:*|*:0:*|*:*:0:*|*:*:*:0)
    fail "rotation limits and pause budget must be positive integers"
    exit 2
    ;;
esac

mkdir -p "${STATE_DIR}"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  exit 0
fi

now_epoch="$(date +%s)"

state_key_for() {
  log_basename="${2##*/}"
  printf '%s-%s' "$1" "$(printf '%s' "${log_basename}" | tr -c 'A-Za-z0-9._-' '_')"
}

rotation_due() {
  service_name="$1"
  log_file="$2"

  [ -f "${log_file}" ] || return 1
  file_size="$(stat -f %z "${log_file}")"
  [ "${file_size}" -gt 0 ] || return 1
  if [ "${file_size}" -ge "${MAX_BYTES}" ]; then
    return 0
  fi

  state_key="$(state_key_for "${service_name}" "${log_file}")"
  state_file="${STATE_DIR}/${state_key}.epoch"
  last_epoch=0
  if [ -r "${state_file}" ]; then
    IFS= read -r last_epoch <"${state_file}" || last_epoch=0
  fi
  case "${last_epoch}" in
    ''|*[!0-9]*) last_epoch=0 ;;
  esac

  [ $((now_epoch - last_epoch)) -ge "${MAX_AGE_SECONDS}" ]
}

find_writer_pid() {
  process_pattern="$1"
  pids="$(pgrep -U "${SERVICE_USER}" -f "${process_pattern}" 2>/dev/null || true)"
  pid_count="$(printf '%s\n' "${pids}" | awk 'NF { count += 1 } END { print count + 0 }')"
  if [ "${pid_count}" -ne 1 ]; then
    fail "expected one ${SERVICE_USER} writer matching ${process_pattern}; found ${pid_count}"
    return 1
  fi
  printf '%s\n' "${pids}"
}

stop_writer() {
  writer_pid="$1"
  service_name="$2"
  PAUSE_STARTED_MS="$(milliseconds_now)"
  kill -STOP "${writer_pid}"
  STOPPED_PID="${writer_pid}"
  STOPPED_SERVICE="${service_name}"

  attempt=0
  while [ "${attempt}" -lt 20 ]; do
    process_state="$(ps -o state= -p "${writer_pid}" 2>/dev/null | tr -d ' ' || true)"
    case "${process_state}" in
      *T*) return 0 ;;
      '') fail "writer ${writer_pid} exited before rotation"; return 1 ;;
    esac
    attempt=$((attempt + 1))
    sleep 0.05
  done

  fail "writer ${writer_pid} did not enter a stopped state"
  return 1
}

clone_with_pause_budget() {
  log_file="$1"
  snapshot_file="$2"
  cp -c "${log_file}" "${snapshot_file}" &
  copy_pid=$!

  while kill -0 "${copy_pid}" 2>/dev/null; do
    elapsed_ms="$(pause_elapsed_ms)"
    if [ "${elapsed_ms}" -ge "${MAX_PAUSE_MS}" ]; then
      kill -TERM "${copy_pid}" 2>/dev/null || true
      wait "${copy_pid}" 2>/dev/null || true
      fail "clone budget exceeded for ${log_file}; elapsed_ms=${elapsed_ms} budget_ms=${MAX_PAUSE_MS}; live inode was not truncated"
      return 1
    fi
    sleep 0.01
  done

  if ! wait "${copy_pid}"; then
    fail "could not clone ${log_file}; incomplete snapshot remains at ${snapshot_file}"
    return 1
  fi

  elapsed_ms="$(pause_elapsed_ms)"
  if [ "${elapsed_ms}" -ge "${MAX_PAUSE_MS}" ]; then
    fail "clone completed outside pause budget for ${log_file}; elapsed_ms=${elapsed_ms} budget_ms=${MAX_PAUSE_MS}; live inode was not truncated"
    return 1
  fi
}

shift_archives() {
  log_file="$1"
  oldest_index=$((MAX_ARCHIVES - 1))
  archive_index="${oldest_index}"
  while [ "${archive_index}" -gt 0 ]; do
    previous_index=$((archive_index - 1))
    if [ -e "${log_file}.${previous_index}" ]; then
      mv "${log_file}.${previous_index}" "${log_file}.${archive_index}"
    fi
    archive_index="${previous_index}"
  done
}

snapshot_path_for() {
  printf '%s.snapshot.pending\n' "$1"
}

prepare_snapshot() {
  service_name="$1"
  log_file="$2"
  manifest_file="$3"
  original_inode="$(stat -f %i "${log_file}")"
  original_size="$(stat -f %z "${log_file}")"
  snapshot_file="$(snapshot_path_for "${log_file}")"
  if [ -e "${snapshot_file}" ]; then
    fail "pending snapshot requires operator review before retry: ${snapshot_file}"
    return 1
  fi

  # APFS clonefile makes a point-in-time copy without reading the full file.
  # The writer stays stopped until every due file is cloned and truncated.
  clone_with_pause_budget "${log_file}" "${snapshot_file}"
  printf '%s|%s|%s|%s|%s\n' \
    "${service_name}" "${log_file}" "${snapshot_file}" "${original_inode}" "${original_size}" >>"${manifest_file}"
}

truncate_live_files() {
  manifest_file="$1"
  while IFS='|' read -r service_name log_file snapshot_file original_inode original_size; do
    [ -n "${log_file}" ] || continue
    : >"${log_file}"
    current_inode="$(stat -f %i "${log_file}")"
    if [ "${current_inode}" != "${original_inode}" ]; then
      fail "inode changed while rotating ${log_file}"
      return 1
    fi
  done <"${manifest_file}"
}

finalize_snapshot() {
  service_name="$1"
  log_file="$2"
  snapshot_file="$3"
  original_inode="$4"
  original_size="$5"
  archive_tmp="${snapshot_file}.retained"

  # The writer is already running again. Retain only the newest MAX_BYTES from
  # the point-in-time clone, then overwrite the full clone with that bounded file.
  tail -c "${MAX_BYTES}" "${snapshot_file}" >"${archive_tmp}"
  chmod 0640 "${archive_tmp}"
  mv "${archive_tmp}" "${snapshot_file}"
  shift_archives "${log_file}"
  mv "${snapshot_file}" "${log_file}.0"

  state_key="$(state_key_for "${service_name}" "${log_file}")"
  state_tmp="$(mktemp "${STATE_DIR}/${state_key}.XXXXXX")"
  printf '%s\n' "${now_epoch}" >"${state_tmp}"
  mv "${state_tmp}" "${STATE_DIR}/${state_key}.epoch"
  printf '%s|%s|%s\n' "${now_epoch}" "${original_size}" "${log_file}" >"${STATE_DIR}/${state_key}.latest"
  ROTATED_SUMMARY="${ROTATED_SUMMARY}${log_file}|${original_size}|${original_inode}\n"
}

rotate_group() {
  service_name="$1"
  process_pattern="$2"
  shift 2

  any_due=0
  for log_file in "$@"; do
    if rotation_due "${service_name}" "${log_file}"; then
      any_due=1
    fi
  done
  [ "${any_due}" -eq 1 ] || return 0

  for log_file in "$@"; do
    if rotation_due "${service_name}" "${log_file}"; then
      snapshot_file="$(snapshot_path_for "${log_file}")"
      if [ -e "${snapshot_file}" ]; then
        fail "pending snapshot requires operator review before retry: ${snapshot_file}"
        return 1
      fi
    fi
  done

  writer_pid="$(find_writer_pid "${process_pattern}")" || return 1
  manifest_file="${STATE_DIR}/${service_name}-manifest"
  : >"${manifest_file}"
  stop_writer "${writer_pid}" "${service_name}" || return 1

  for log_file in "$@"; do
    if rotation_due "${service_name}" "${log_file}"; then
      prepare_snapshot "${service_name}" "${log_file}" "${manifest_file}"
    fi
  done
  truncate_live_files "${manifest_file}"
  resume_writer

  while IFS='|' read -r manifest_service manifest_log manifest_snapshot manifest_inode manifest_size; do
    [ -n "${manifest_log}" ] || continue
    finalize_snapshot "${manifest_service}" "${manifest_log}" "${manifest_snapshot}" "${manifest_inode}" "${manifest_size}"
  done <"${manifest_file}"
  : >"${manifest_file}"

  printf '%b' "${ROTATED_SUMMARY}" | while IFS='|' read -r rotated_file rotated_size rotated_inode; do
    [ -n "${rotated_file}" ] || continue
    log_notice "rotated ${rotated_file} at ${rotated_size} bytes; inode ${rotated_inode} preserved"
  done
  ROTATED_SUMMARY=""
  if ! kill -0 "${writer_pid}" 2>/dev/null; then
    fail "writer ${writer_pid} did not survive rotation"
    return 1
  fi
}

run_rotation() {
  if [ "${LOG_ROTATION_TEST_MODE:-0}" = "1" ]; then
    rotate_group \
      "fixture" \
      "${LOG_ROTATION_TEST_PROCESS_PATTERN:?test process pattern is required}" \
      "${LOG_ROTATION_TEST_LOG:?test log is required}"
    return
  fi

  rotate_group \
    "inngest" \
    '^/Users/Shared/joelclaw/opt/inngest/[^/]*/inngest ' \
    "${CENTRAL_ROOT}/logs/inngest/launchd.err.log" \
    "${CENTRAL_ROOT}/logs/inngest/launchd.out.log"

  rotate_group \
    "typesense" \
    '^/opt/homebrew/opt/typesense-server@[^/]*/bin/typesense-server ' \
    "${CENTRAL_ROOT}/logs/typesense/typesense.log"
}

run_rotation
