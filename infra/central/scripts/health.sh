#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

status=0
CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS="${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS:-10}"
SESSION_INDEX_PATH="${SESSION_INDEX_PATH:-/Users/joel/.joelclaw/search/sessions.db}"
RUNS_ROOT="${RUNS_ROOT:-/Users/joel/.joelclaw/runs-dev}"
MAX_INDEX_LAG_SECONDS="${MAX_INDEX_LAG_SECONDS:-300}"
PG_ISREADY_BIN="${PG_ISREADY_BIN:-/opt/homebrew/opt/postgresql@17/bin/pg_isready}"
SYSTEM_BUS_APP_NAME="${SYSTEM_BUS_APP_NAME:-system-bus-host}"
BRAIN_PAPER_URL="${BRAIN_PAPER_URL:-https://brain.joelclaw.com}"

if ! [[ "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]] ||
  [[ "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" -lt 1 || "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" -gt 30 ]]; then
  CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS=10
fi

if ! [[ "${MAX_INDEX_LAG_SECONDS}" =~ ^[0-9]+$ ]]; then
  fail "MAX_INDEX_LAG_SECONDS must be a non-negative integer"
fi

probe() {
  local label="$1"
  shift
  local output
  output="$(mktemp -t central-health.XXXXXX)"
  if "$@" >"${output}" 2>&1; then
    printf 'ok   %s\n' "${label}"
  else
    printf 'fail %s\n' "${label}"
    while IFS= read -r line; do
      printf '     %s\n' "${line}"
    done <"${output}"
    status=1
  fi
  rm -f "${output}"
}

http_ok() {
  local url="$1"
  curl --noproxy '*' --connect-timeout 3 \
    --max-time "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" -fsS "${url}" >/dev/null
}

redis_ok() {
  local out
  out="$(
    { printf '*1\r\n$4\r\nPING\r\n'; sleep 0.1; } |
      nc -w 5 "${CENTRAL_BIND_ADDR}" 6379 2>/dev/null || true
  )"
  grep -q PONG <<<"${out}"
}

postgres_ok() {
  [[ -x "${PG_ISREADY_BIN}" ]] || {
    printf 'missing pg_isready: %s\n' "${PG_ISREADY_BIN}"
    return 1
  }
  "${PG_ISREADY_BIN}" -h "${CENTRAL_BIND_ADDR}" -p 5432 \
    -t "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}"
}

system_bus_registered() {
  local worker_json
  local inngest_json
  worker_json="$(mktemp -t central-health-worker.XXXXXX)"
  inngest_json="$(mktemp -t central-health-inngest.XXXXXX)"

  if ! curl --noproxy '*' --connect-timeout 3 \
    --max-time "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" -fsS \
    "http://${CENTRAL_BIND_ADDR}:3111/api/inngest" >"${worker_json}"; then
    rm -f "${worker_json}" "${inngest_json}"
    return 1
  fi

  if ! curl --noproxy '*' --connect-timeout 3 \
    --max-time "${CENTRAL_HEALTH_PROBE_TIMEOUT_SECONDS}" -fsS \
    -H 'content-type: application/json' \
    --data '{"query":"query { apps { name functions { id } } }"}' \
    "http://${CENTRAL_BIND_ADDR}:8288/v0/gql" >"${inngest_json}"; then
    rm -f "${worker_json}" "${inngest_json}"
    return 1
  fi

  local rc=0
  python3 - "${worker_json}" "${inngest_json}" "${SYSTEM_BUS_APP_NAME}" <<'PY' || rc=$?
import json, sys
worker_path, inngest_path, app_name = sys.argv[1:]
with open(worker_path, encoding="utf-8") as handle:
    expected = int(json.load(handle).get("function_count", 0))
with open(inngest_path, encoding="utf-8") as handle:
    body = json.load(handle)
apps = body.get("data", {}).get("apps", [])
app = next((item for item in apps if item.get("name") == app_name), None)
registered = len(app.get("functions", [])) if app else 0
if expected <= 0 or registered != expected:
    print(f"worker_exposed={expected} inngest_registered={registered} app={app_name}")
    raise SystemExit(1)
PY
  rm -f "${worker_json}" "${inngest_json}"
  return "${rc}"
}

session_index_current() {
  python3 - "${RUNS_ROOT}" "${SESSION_INDEX_PATH}" "${MAX_INDEX_LAG_SECONDS}" <<'PY'
import glob, os, re, sqlite3, sys
runs_root, database_path, max_lag_text = sys.argv[1:]
max_lag = int(max_lag_text)
month_dirs = [
    path
    for path in glob.glob(os.path.join(runs_root, "*", "*"))
    if os.path.isdir(path) and re.fullmatch(r"\d{4}-\d{2}", os.path.basename(path))
]
if not month_dirs:
    print(f"raw Run store has no month directories: {runs_root}")
    raise SystemExit(1)
if not os.path.isfile(database_path):
    print(f"sessions.db missing: {database_path}")
    raise SystemExit(1)
raw_epoch = int(max(os.stat(path).st_mtime for path in month_dirs))
uri = f"file:{database_path}?mode=ro"
with sqlite3.connect(uri, uri=True) as database:
    row_count, captured_at = database.execute(
        "SELECT COUNT(*), COALESCE(MAX(captured_at), 0) FROM runs"
    ).fetchone()
indexed_epoch = int(captured_at / 1000 if captured_at > 10_000_000_000 else captured_at)
lag = max(0, raw_epoch - indexed_epoch)
if row_count <= 0 or indexed_epoch <= 0 or lag > max_lag:
    print(
        f"rows={row_count} raw={raw_epoch} indexed={indexed_epoch} "
        f"lag={lag}s max_lag={max_lag}s"
    )
    raise SystemExit(1)
PY
}

launchd_running() {
  local label="$1"
  launchctl print "system/${label}" 2>/dev/null | grep -q 'state = running'
}

require_command curl
require_command launchctl
require_command nc
require_command python3

printf 'Flagg Central health (read-only)\n'
probe 'nas mounts verified' "${SCRIPT_DIR}/verify-nas.sh"
probe 'redis ping' redis_ok
probe 'postgres accepting connections' postgres_ok
probe 'typesense /health' http_ok "http://${CENTRAL_BIND_ADDR}:8108/health"
probe 'inngest /health' http_ok "http://${CENTRAL_BIND_ADDR}:8288/health"
probe 'system-bus functions registered' system_bus_registered
probe 'executor app' http_ok "http://${CENTRAL_BIND_ADDR}:4788/health"
probe 'executor dashboard' http_ok "http://${CENTRAL_BIND_ADDR}:4789/"
probe 'wiki local' http_ok "http://${CENTRAL_BIND_ADDR}:8790/"
probe 'Brain paper' http_ok "${BRAIN_PAPER_URL}"
probe 'agent-mail' http_ok "http://${CENTRAL_BIND_ADDR}:8765/"
probe 'session index current' session_index_current
probe 'ds4 models' http_ok "http://${CENTRAL_BIND_ADDR}:8000/v1/models"
probe 'gateway launchd running' launchd_running com.joel.gateway
probe 'agent-secrets launchd running' launchd_running com.joel.agent-secrets

exit "${status}"
