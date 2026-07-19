#!/usr/bin/env bash
# joelclaw postboot system check -- read-only health sweep for Flagg/Panda split
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${JOELCLAW_REPO_DIR:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
CENTRAL_SCRIPTS="${REPO_DIR}/infra/central/scripts"
SERVICE_REPO="${SERVICE_REPO:-/Users/Shared/joelclaw/src/joelclaw}"
SERVICE_CENTRAL_SCRIPTS="${SERVICE_REPO}/infra/central/scripts"
LOCAL_CONVEX_DIR="${LOCAL_CONVEX_DIR:-/Users/joel/Documents/Codex/2026-06-17/we-re-setting-up-durable-self/work/local-convex}"
SYSTEM_ENV="${SYSTEM_ENV:-${HOME}/.config/system-bus.env}"

NAS_IP="${NAS_IP:-192.168.1.163}"
NAS_EXPECTED_INTERFACE="${NAS_EXPECTED_INTERFACE:-en0}"
NAS_EXPECTED_MTU="${NAS_EXPECTED_MTU:-8192}"
CUSTOM_MINIO_URL="${CUSTOM_MINIO_URL:-http://100.67.156.41:39000}"
CUSTOM_MINIO_CONSOLE_URL="${CUSTOM_MINIO_CONSOLE_URL:-http://100.67.156.41:39001}"
CE_MINIO_URL="${CE_MINIO_URL:-http://100.67.156.41:29990}"
LOCAL_CONVEX_URL="${LOCAL_CONVEX_URL:-http://127.0.0.1:3210}"
LOCAL_CONVEX_DASHBOARD="${LOCAL_CONVEX_DASHBOARD:-http://127.0.0.1:6791}"
LAN_CONVEX_URL="${LAN_CONVEX_URL:-http://192.168.1.10:3210}"
TAILNET_CONVEX_URL="${TAILNET_CONVEX_URL:-http://100.99.76.47:3210}"
POSTGRES_SOCKET="${POSTGRES_SOCKET:-/Users/Shared/joelclaw/run/.s.PGSQL.5432}"
POSTGRES_HOST="${POSTGRES_HOST:-127.0.0.1}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTBOOT_NAS_BENCHMARK_MIB="${POSTBOOT_NAS_BENCHMARK_MIB:-1}"
POSTBOOT_HEAVY="${POSTBOOT_HEAVY:-0}"

CHECKS=0
FAILS=0
WARNS=0
TMP_FILES=()

cleanup() {
  local f
  for f in "${TMP_FILES[@]:-}"; do
    [[ -n "$f" ]] && rm -f "$f"
  done
}
trap cleanup EXIT

have() {
  command -v "$1" >/dev/null 2>&1
}

tmpfile() {
  local f
  f="$(mktemp "${TMPDIR:-/tmp}/postboot-check.XXXXXX")"
  TMP_FILES+=("$f")
  printf '%s\n' "$f"
}

sanitize() {
  sed -E \
    -e 's/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|POSTGRES_URL|CONVEX_DEPLOY_KEY|ADMIN_KEY|ACCESS_KEY|SECRET_KEY)=([^[:space:]]+)/\1=<redacted>/Ig' \
    -e 's#(https?://)[^:/[:space:]]+:[^@[:space:]]+@#\1<redacted>:<redacted>@#g'
}

print_failure_detail() {
  local file="$1"
  if [[ -s "$file" ]]; then
    sanitize <"$file" | sed -n '1,8p' | sed 's/^/      /'
  fi
}

pass() {
  local label="$1" detail="${2:-}"
  CHECKS=$((CHECKS + 1))
  printf 'OK    %-34s %s\n' "$label" "$detail"
}

warn_result() {
  local label="$1" detail="${2:-}"
  CHECKS=$((CHECKS + 1))
  WARNS=$((WARNS + 1))
  printf 'WARN  %-34s %s\n' "$label" "$detail"
}

fail_result() {
  local label="$1" detail="${2:-}"
  CHECKS=$((CHECKS + 1))
  FAILS=$((FAILS + 1))
  printf 'FAIL  %-34s %s\n' "$label" "$detail"
}

probe() {
  local severity="$1"
  local label="$2"
  shift 2
  local out
  out="$(tmpfile)"
  if "$@" >"$out" 2>&1; then
    pass "$label"
  else
    if [[ "$severity" == "warn" ]]; then
      warn_result "$label"
    else
      fail_result "$label"
    fi
    print_failure_detail "$out"
  fi
}

env_value() {
  local key="$1"
  [[ -r "$SYSTEM_ENV" ]] || return 1
  awk -F= -v key="$key" '
    $1 == key {
      value=$0
      sub("^[^=]*=", "", value)
      gsub(/^["'\'' ]+|["'\'' ]+$/, "", value)
      print value
      exit
    }
  ' "$SYSTEM_ENV"
}

http_ok() {
  local url="$1"
  curl -fsS --max-time 5 "$url" >/dev/null
}

http_head_ok() {
  local url="$1"
  curl -fsSI --max-time 5 "$url" >/dev/null
}

tcp_ok() {
  local host="$1"
  local port="$2"
  nc -z -w 5 "$host" "$port"
}

json_ok() {
  local command_name="$1"
  shift
  local out
  out="$("$@" 2>&1)" || {
    printf '%s\n' "$out"
    return 1
  }
  if have jq; then
    jq -e '.ok == true' >/dev/null <<<"$out" || {
      printf '%s\n' "$out"
      return 1
    }
  elif ! grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$out"; then
    printf '%s\n' "$out"
    return 1
  fi
  printf '%s ok\n' "$command_name"
}

run_capture_ok() {
  python3 - <<'PY'
import json
import os
import urllib.request

auth_path = os.path.expanduser("~/.joelclaw/auth.json")
with open(auth_path, "r", encoding="utf-8") as f:
    token = json.load(f).get("token", "")

req = urllib.request.Request(
    "https://panda.tail7af24.ts.net/api/runs/health",
    headers={"Authorization": "Bearer " + token},
)

with urllib.request.urlopen(req, timeout=10) as response:
    body = response.read(500).decode("utf-8", "replace")
    if response.status != 200:
        raise SystemExit(f"status={response.status}")
    parsed = json.loads(body)
    if parsed.get("ok") is not True:
        raise SystemExit(body)
    print("run capture ok")
PY
}

launchd_system_ok() {
  local label="$1"
  local out
  out="$(tmpfile)"
  launchctl print "system/${label}" >"$out" 2>&1 || {
    cat "$out"
    return 1
  }
  if grep -Eq 'last exit code = [1-9][0-9]*' "$out"; then
    cat "$out"
    return 1
  fi
}

launchd_user_ok() {
  local label="$1"
  local out
  out="$(tmpfile)"
  launchctl print "gui/$(id -u)/${label}" >"$out" 2>&1 || {
    cat "$out"
    return 1
  }
  if grep -Eq 'last exit code = [1-9][0-9]*' "$out"; then
    cat "$out"
    return 1
  fi
}

authority_shape_ok() {
  local host central_url typesense_url
  host="$(hostname -s 2>/dev/null || hostname)"
  central_url="$(env_value JOELCLAW_CENTRAL_URL || true)"
  typesense_url="$(env_value TYPESENSE_URL || env_value JOELCLAW_TYPESENSE_URL || true)"

  central_url="${central_url%/}"
  typesense_url="${typesense_url%/}"

  printf 'host=%s central=%s typesense=%s\n' \
    "$host" \
    "${central_url:-<unset>}" \
    "${typesense_url:-<unset>}"

  if [[ "$host" == "flagg" || "$host" == "flagg.localdomain" ]]; then
    case "$central_url" in
      http://localhost:3111|http://127.0.0.1:3111|http://joels-mac-studio.tail7af24.ts.net:3111) ;;
      *) return 1 ;;
    esac
    case "$typesense_url" in
      http://localhost:8108|http://127.0.0.1:8108|http://joels-mac-studio.tail7af24.ts.net:8108) ;;
      *) return 1 ;;
    esac
  fi
}

nas_route_ok() {
  local route iface mtu
  route="$(route -n get "$NAS_IP" 2>/dev/null)"
  iface="$(awk '/interface:/ {print $2; exit}' <<<"$route")"
  mtu="$(awk '
    /(^|[[:space:]])mtu([[:space:]]|$)/ {
      for (i = 1; i <= NF; i++) {
        if ($i == "mtu") {
          idx = i
          getline
          print $idx
          exit
        }
      }
    }
  ' <<<"$route")"
  printf 'interface=%s mtu=%s expected_interface=%s expected_mtu=%s\n' \
    "${iface:-unknown}" "${mtu:-unknown}" "$NAS_EXPECTED_INTERFACE" "$NAS_EXPECTED_MTU"
  [[ "$iface" == "$NAS_EXPECTED_INTERFACE" ]] || return 1
  [[ "$mtu" == "$NAS_EXPECTED_MTU" ]] || return 1
}

nas_mount_status_ok() {
  bash "${CENTRAL_SCRIPTS}/mount-nas.sh" status
}

nas_mount_helper_executable_ok() {
  local helper="${SERVICE_CENTRAL_SCRIPTS}/mount-nas.sh"
  [[ -x "$helper" ]] || {
    printf 'missing or not executable: %s\n' "$helper"
    return 1
  }
}

nas_verify_ok() {
  local verifier="${SERVICE_CENTRAL_SCRIPTS}/verify-nas.sh"
  [[ -x "$verifier" ]] || verifier="${CENTRAL_SCRIPTS}/verify-nas.sh"
  "$verifier" --write-probe --benchmark-mib "$POSTBOOT_NAS_BENCHMARK_MIB"
}

nfs_options_ok() {
  nfsstat -m | grep -q 'rsize=524288' || return 1
  nfsstat -m | grep -q 'wsize=524288' || return 1
  nfsstat -m | grep -q 'readahead=128' || return 1
}

postgres_ready_ok() {
  if have pg_isready; then
    pg_isready -h "$(dirname "$POSTGRES_SOCKET")" -p "$POSTGRES_PORT" -d postgres
  elif [[ -x /opt/homebrew/opt/postgresql@17/bin/pg_isready ]]; then
    /opt/homebrew/opt/postgresql@17/bin/pg_isready -h "$(dirname "$POSTGRES_SOCKET")" -p "$POSTGRES_PORT" -d postgres
  else
    test -S "$POSTGRES_SOCKET" && tcp_ok "$POSTGRES_HOST" "$POSTGRES_PORT"
  fi
}

convex_version_ok() {
  local url="$1"
  local body
  body="$(curl -fsS --max-time 5 "${url}/version")"
  [[ -n "$body" ]]
}

convex_heavy_smoke() {
  [[ "$POSTBOOT_HEAVY" == "1" ]] || {
    printf 'POSTBOOT_HEAVY=0; skipping write/read/delete smoke\n'
    return 0
  }
  [[ -x "${LOCAL_CONVEX_DIR}/smoke-self-hosted-convex.sh" ]] || {
    printf 'missing smoke script: %s\n' "${LOCAL_CONVEX_DIR}/smoke-self-hosted-convex.sh"
    return 1
  }
  (cd "$LOCAL_CONVEX_DIR" && ./smoke-self-hosted-convex.sh)
}

run_full_health_if_requested() {
  [[ "${POSTBOOT_RUN_FULL_HEALTH:-0}" == "1" ]] || {
    printf 'POSTBOOT_RUN_FULL_HEALTH=0; skipping legacy full health script\n'
    return 0
  }
  "${SCRIPT_DIR}/health.sh"
}

BOOT_EPOCH="$(sysctl -n kern.boottime 2>/dev/null | awk -F'[=,]' '{gsub(/ /, "", $2); print $2}')"
BOOT_ISO=""
if [[ -n "${BOOT_EPOCH:-}" ]]; then
  BOOT_ISO="$(date -u -r "$BOOT_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
fi

printf '====================================================\n'
printf '  joelclaw postboot system check -- %s\n' "$(date '+%Y-%m-%d %H:%M')"
printf '====================================================\n'
printf 'host=%s boot=%s repo=%s\n' "$(hostname -s 2>/dev/null || hostname)" "${BOOT_ISO:-unknown}" "$REPO_DIR"
printf '\n'

probe required 'authority split env' authority_shape_ok
probe warn 'joelclaw aggregate status' json_ok 'joelclaw status' joelclaw status --json
probe warn 'joelclaw Inngest CLI' json_ok 'joelclaw inngest status' joelclaw inngest status --json

configured_inngest="$(env_value INNGEST_URL || true)"
if [[ -z "$configured_inngest" ]]; then
  if [[ "$(hostname -s 2>/dev/null || hostname)" == "flagg" ]]; then
    configured_inngest="http://panda:8288"
  else
    configured_inngest="http://127.0.0.1:8288"
  fi
fi
probe required 'Inngest direct /health' http_ok "${configured_inngest%/}/health"
probe required 'Run capture health' run_capture_ok

configured_typesense="$(env_value TYPESENSE_URL || env_value JOELCLAW_TYPESENSE_URL || true)"
if [[ -n "$configured_typesense" ]]; then
  probe required 'typesense configured /health' http_ok "${configured_typesense%/}/health"
else
  probe required 'typesense localhost /health' http_ok 'http://127.0.0.1:8108/health'
fi

probe required 'nas launchd label' launchd_system_ok com.joelclaw.central.nas-mounts
probe required 'nas launchd helper executable' nas_mount_helper_executable_ok
probe required 'nas route 10GbE/MTU' nas_route_ok
probe required 'nas mounts status' nas_mount_status_ok
probe required 'nas verifier write probe' nas_verify_ok
probe required 'nfs tuned options' nfs_options_ok

probe required 'custom MinIO ready' http_ok "${CUSTOM_MINIO_URL}/minio/health/ready"
probe required 'custom MinIO live' http_ok "${CUSTOM_MINIO_URL}/minio/health/live"
probe warn 'custom MinIO console tcp' tcp_ok "$(sed -E 's#^https?://([^:/]+).*#\1#' <<<"$CUSTOM_MINIO_CONSOLE_URL")" "$(sed -E 's#^https?://[^:/]+:([0-9]+).*#\1#' <<<"$CUSTOM_MINIO_CONSOLE_URL")"
probe warn 'ASUSTOR MinIO CE reference' http_ok "${CE_MINIO_URL}/minio/health/ready"

probe required 'Central Postgres socket' test -S "$POSTGRES_SOCKET"
probe required 'Central Postgres tcp' tcp_ok "$POSTGRES_HOST" "$POSTGRES_PORT"
probe required 'Central Postgres ready' postgres_ready_ok

probe required 'local Convex backend' convex_version_ok "$LOCAL_CONVEX_URL"
probe required 'local Convex dashboard' http_head_ok "$LOCAL_CONVEX_DASHBOARD"
probe warn 'Convex LAN forward' convex_version_ok "$LAN_CONVEX_URL"
probe warn 'Convex tailnet forward' convex_version_ok "$TAILNET_CONVEX_URL"
probe warn 'Convex heavy smoke gate' convex_heavy_smoke
probe warn 'local Convex LAN launchd' launchd_user_ok com.joelclaw.local-convex.lan-forwarder

probe warn 'Flagg shadow central health' "${CENTRAL_SCRIPTS}/health.sh"
probe warn 'legacy full health gate' run_full_health_if_requested

printf '\n====================================================\n'
if [[ "$FAILS" -eq 0 ]]; then
  printf '  POSTBOOT: PASS (%d checks, %d warnings)\n' "$CHECKS" "$WARNS"
else
  printf '  POSTBOOT: FAIL (%d checks, %d failures, %d warnings)\n' "$CHECKS" "$FAILS" "$WARNS"
fi
printf '====================================================\n'

if [[ "$FAILS" -gt 0 ]]; then
  exit 1
fi

exit 0
