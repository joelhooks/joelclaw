#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

status=0

probe() {
  local label="$1"
  shift
  if "$@" >/tmp/central-health.$$ 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'fail %s\n' "$label"
    while IFS= read -r line; do
      printf '     %s\n' "$line"
    done < /tmp/central-health.$$
    status=1
  fi
  rm -f /tmp/central-health.$$
}

http_ok() {
  local url="$1"
  curl -fsS --max-time 5 "$url" >/dev/null
}

tcp_ok() {
  local host="$1"
  local port="$2"
  nc -z -w 5 "$host" "$port"
}

redis_ok() {
  local out
  out="$( { printf '*1\r\n$4\r\nPING\r\n'; sleep 0.1; } | nc -w 5 "$CENTRAL_BIND_ADDR" 6379 2>/dev/null || true )"
  grep -q PONG <<<"$out"
}

require_command curl
require_command nc

printf 'Flagg Central shadow health\n'
probe 'redis ping' redis_ok
probe 'typesense /health' http_ok "http://${CENTRAL_BIND_ADDR}:8108/health"
probe 'inngest /health' http_ok "http://${CENTRAL_BIND_ADDR}:8288/health"
probe 'restate ingress tcp' tcp_ok "$CENTRAL_BIND_ADDR" 8080
probe 'restate admin tcp' tcp_ok "$CENTRAL_BIND_ADDR" 9070
probe 'minio ready' http_ok "http://${CENTRAL_BIND_ADDR}:9000/minio/health/ready"

exit "$status"
