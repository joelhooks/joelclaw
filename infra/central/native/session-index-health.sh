#!/bin/sh
set -eu

CENTRAL_ROOT="${CENTRAL_ROOT:-/Users/Shared/joelclaw}"
RUNS_ROOT="${RUNS_ROOT:-/Users/joel/.joelclaw/runs-dev}"
TYPESENSE_URL="${TYPESENSE_URL:-http://127.0.0.1:8108}"
WORKER_URL="${WORKER_URL:-http://127.0.0.1:3111}"
INNGEST_URL="${INNGEST_URL:-http://127.0.0.1:8288}"
MAX_INDEX_LAG_SECONDS="${MAX_INDEX_LAG_SECONDS:-300}"
RECOVER_AFTER_FAILURES="${RECOVER_AFTER_FAILURES:-3}"
RECOVERY_COOLDOWN_SECONDS="${RECOVERY_COOLDOWN_SECONDS:-900}"
STATE_DIR="${STATE_DIR:-${CENTRAL_ROOT}/state/session-index-health}"
TYPESENSE_ENV="${TYPESENSE_ENV:-${CENTRAL_ROOT}/etc/typesense/typesense.env}"
LOG_PREFIX="session-index-health"

mkdir -p "${STATE_DIR}"
FAILURE_FILE="${STATE_DIR}/consecutive-failures"
LAST_RECOVERY_FILE="${STATE_DIR}/last-recovery-epoch"
LAST_STATUS_FILE="${STATE_DIR}/last-emitted-status"
PENDING_OTEL_FILE="${STATE_DIR}/pending-otel.json"
PENDING_STATUS_FILE="${STATE_DIR}/pending-otel-status"
RECEIPT_FILE="${STATE_DIR}/latest.json"

number_file() {
  file="$1"
  fallback="$2"
  value="${fallback}"
  if [ -r "${file}" ]; then
    value="$(tr -dc '0-9' <"${file}" | head -c 20)"
  fi
  [ -n "${value}" ] || value="${fallback}"
  printf '%s' "${value}"
}

write_number() {
  printf '%s\n' "$2" >"$1"
}

log() {
  printf '[%s] %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOG_PREFIX}" "$*"
}

http_ok() {
  curl --noproxy '*' --connect-timeout 2 --max-time 5 -fsS "$1" >/dev/null 2>&1
}

newest_raw_epoch() {
  [ -d "${RUNS_ROOT}" ] || return 1
  python3 - "${RUNS_ROOT}" <<'PY'
import glob, json, os, re, sys
root = sys.argv[1]
month_dirs = [path for path in glob.glob(os.path.join(root, "*", "*")) if re.fullmatch(r"\d{4}-\d{2}", os.path.basename(path))]
if not month_dirs:
    raise SystemExit(1)
latest_month = max(os.path.basename(path) for path in month_dirs)
latest = 0
for directory in month_dirs:
    if os.path.basename(directory) != latest_month:
        continue
    for path in glob.glob(os.path.join(directory, "*.metadata.json")):
        try:
            with open(path, encoding="utf-8") as handle:
                value = json.load(handle).get("started_at")
            if isinstance(value, (int, float)):
                latest = max(latest, int(value / 1000 if value > 10_000_000_000 else value))
        except (OSError, ValueError):
            continue
if latest <= 0:
    raise SystemExit(1)
print(latest)
PY
}

read_typesense_key() {
  [ -r "${TYPESENSE_ENV}" ] || return 1
  python3 - "${TYPESENSE_ENV}" <<'PY'
import sys
for line in open(sys.argv[1], encoding="utf-8"):
    key, separator, value = line.partition("=")
    if separator and key.strip() == "TYPESENSE_API_KEY":
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if value:
            print(value)
            raise SystemExit(0)
raise SystemExit(1)
PY
}

newest_indexed_epoch() {
  TYPESENSE_API_KEY="$(read_typesense_key)" || return 1
  response="$(curl --noproxy '*' --connect-timeout 2 --max-time 8 -fsS \
    -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
    --get "${TYPESENSE_URL}/collections/runs_dev/documents/search" \
    --data-urlencode 'q=*' \
    --data-urlencode 'query_by=full_text' \
    --data-urlencode 'sort_by=started_at:desc' \
    --data-urlencode 'per_page=1')" || return 1
  printf '%s' "${response}" | python3 -c '
import json, sys
body = json.load(sys.stdin)
value = body.get("hits", [{}])[0].get("document", {}).get("started_at")
if not isinstance(value, (int, float)):
    raise SystemExit(1)
print(int(value / 1000 if value > 10_000_000_000 else value))
'
}

post_otel() {
  curl --noproxy '*' --connect-timeout 2 --max-time 5 -fsS \
    -H 'content-type: application/json' \
    --data-binary "@$1" "${WORKER_URL}/observability/emit" >/dev/null 2>&1
}

emit_otel() {
  status="$1"
  reason="$2"
  lag="$3"

  if [ -s "${PENDING_OTEL_FILE}" ] && [ -s "${PENDING_STATUS_FILE}" ]; then
    if post_otel "${PENDING_OTEL_FILE}"; then
      cat "${PENDING_STATUS_FILE}" >"${LAST_STATUS_FILE}"
      : >"${PENDING_OTEL_FILE}"
      : >"${PENDING_STATUS_FILE}"
    else
      return 0
    fi
  fi

  previous="$(cat "${LAST_STATUS_FILE}" 2>/dev/null || true)"
  current="${status}:${reason}"
  [ "${current}" != "${previous}" ] || return 0

  level="info"
  success=true
  [ "${status}" = "healthy" ] || { level="error"; success=false; }
  payload="$(python3 - "${level}" "${success}" "${reason}" "${lag}" <<'PY'
import json, sys
level, success, reason, lag = sys.argv[1:]
print(json.dumps({
  "level": level,
  "source": "system",
  "component": "session-index-health",
  "action": "session.index.health_checked",
  "success": success == "true",
  "error": None if success == "true" else reason,
  "metadata": {"reason": reason, "index_lag_seconds": int(lag)},
}))
PY
)"
  printf '%s\n' "${payload}" >"${PENDING_OTEL_FILE}"
  printf '%s\n' "${current}" >"${PENDING_STATUS_FILE}"
  if post_otel "${PENDING_OTEL_FILE}"; then
    printf '%s\n' "${current}" >"${LAST_STATUS_FILE}"
    : >"${PENDING_OTEL_FILE}"
    : >"${PENDING_STATUS_FILE}"
  fi
}

write_receipt() {
  status="$1"
  reason="$2"
  raw="$3"
  indexed="$4"
  lag="$5"
  failures="$6"
  python3 - "${status}" "${reason}" "${raw}" "${indexed}" "${lag}" "${failures}" >"${RECEIPT_FILE}.tmp" <<'PY'
import datetime, json, sys
status, reason, raw, indexed, lag, failures = sys.argv[1:]
print(json.dumps({
  "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
  "status": status,
  "reason": reason,
  "newestRawEpoch": int(raw),
  "newestIndexedEpoch": int(indexed),
  "indexLagSeconds": int(lag),
  "consecutiveFailures": int(failures),
}, indent=2))
PY
  mv "${RECEIPT_FILE}.tmp" "${RECEIPT_FILE}"
}

recover() {
  reason="$1"
  now="$2"
  last_recovery="$(number_file "${LAST_RECOVERY_FILE}" 0)"
  age=$((now - last_recovery))
  if [ "${age}" -lt "${RECOVERY_COOLDOWN_SECONDS}" ]; then
    log "recovery cooldown active (${age}/${RECOVERY_COOLDOWN_SECONDS}s, reason=${reason})"
    return 1
  fi

  # Restart only the failing target. worker_unavailable and index_lag_exceeded
  # implicate the host worker, never the event server; unscoped recovery killed
  # healthy Inngest 54 times after the 2026-07-19 reboot.
  restart_inngest=0
  restart_worker=0
  case "${reason}" in
    inngest_unavailable) restart_inngest=1 ;;
    *) restart_worker=1 ;;
  esac

  # kickstart -k is destructive, so the cooldown starts when the attempt starts.
  # Evaluating success first is what produced the 07-19 restart storm: the
  # worker kick kept failing, the cooldown never advanced, and every 60s pass
  # killed Inngest again.
  write_number "${LAST_RECOVERY_FILE}" "${now}"

  inngest_rc=0
  worker_rc=0
  if [ "${restart_inngest}" -eq 1 ]; then
    log "recovering Inngest (reason=${reason})"
    launchctl kickstart -k system/com.joelclaw.central.inngest || inngest_rc=$?
  fi
  if [ "${restart_worker}" -eq 1 ]; then
    log "recovering host worker (reason=${reason})"
    uid="$(id -u joel 2>/dev/null || true)"
    if [ -n "${uid}" ]; then
      launchctl kickstart -k "gui/${uid}/com.joel.system-bus-worker" 2>/dev/null || worker_rc=$?
    else
      worker_rc=1
    fi
  fi
  if [ "${inngest_rc}" -ne 0 ] || [ "${worker_rc}" -ne 0 ]; then
    log "recovery attempt incomplete inngest=${inngest_rc} worker=${worker_rc} (cooldown stamped, retry after ${RECOVERY_COOLDOWN_SECONDS}s)"
    return 1
  fi
  write_number "${FAILURE_FILE}" 0
  return 0
}

case "${MAX_INDEX_LAG_SECONDS}:${RECOVER_AFTER_FAILURES}:${RECOVERY_COOLDOWN_SECONDS}" in
  *[!0-9:]*|'') log 'invalid numeric configuration'; exit 2 ;;
esac

now="$(date +%s)"
raw="$(newest_raw_epoch 2>/dev/null || printf '0')"
indexed="$(newest_indexed_epoch 2>/dev/null || printf '0')"
raw="${raw:-0}"
indexed="${indexed:-0}"
lag=0
[ "${raw}" -le "${indexed}" ] || lag=$((raw - indexed))
status="healthy"
reason="current"
actionable=0

if ! http_ok "${INNGEST_URL}/health"; then
  status="degraded"
  reason="inngest_unavailable"
  actionable=1
elif ! http_ok "${WORKER_URL}/api/inngest"; then
  status="degraded"
  reason="worker_unavailable"
  actionable=1
elif [ "${raw}" -eq 0 ]; then
  status="degraded"
  reason="raw_freshness_unknown"
elif [ "${indexed}" -eq 0 ]; then
  status="degraded"
  reason="index_freshness_unknown"
elif [ "${lag}" -gt "${MAX_INDEX_LAG_SECONDS}" ]; then
  status="degraded"
  reason="index_lag_exceeded"
  actionable=1
fi

failures="$(number_file "${FAILURE_FILE}" 0)"
if [ "${actionable}" -eq 1 ]; then
  failures=$((failures + 1))
  write_number "${FAILURE_FILE}" "${failures}"
else
  failures=0
  write_number "${FAILURE_FILE}" 0
fi

write_receipt "${status}" "${reason}" "${raw}" "${indexed}" "${lag}" "${failures}"
emit_otel "${status}" "${reason}" "${lag}"

if [ "${actionable}" -eq 1 ] && [ "${failures}" -ge "${RECOVER_AFTER_FAILURES}" ]; then
  recover "${reason}" "${now}" || true
fi

if [ "${status}" = "healthy" ]; then
  log "healthy raw=${raw} indexed=${indexed} lag=${lag}s"
  exit 0
fi

log "degraded reason=${reason} raw=${raw} indexed=${indexed} lag=${lag}s failures=${failures}"
exit 1
