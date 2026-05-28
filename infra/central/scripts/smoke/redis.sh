#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_smoke_command nc

key="$(smoke_id):redis"
value="redis-ok-${RANDOM}"

redis_command() {
  local payload="$1"
  { printf '%b' "$payload"; sleep 0.1; } | nc -w 5 "$CENTRAL_BIND_ADDR" 6379
}

bulk_len() {
  printf '%s' "$1" | wc -c | tr -d ' '
}

set_payload="*5\r\n\$3\r\nSET\r\n\$$(bulk_len "$key")\r\n${key}\r\n\$$(bulk_len "$value")\r\n${value}\r\n\$2\r\nEX\r\n\$2\r\n60\r\n"
get_payload="*2\r\n\$3\r\nGET\r\n\$$(bulk_len "$key")\r\n${key}\r\n"
del_payload="*2\r\n\$3\r\nDEL\r\n\$$(bulk_len "$key")\r\n${key}\r\n"

smoke_log "writing isolated Redis key"
set_out="$(redis_command "$set_payload")"
grep -q '^+OK' <<<"$set_out" || fail "Redis SET failed"

smoke_log "reading isolated Redis key"
get_out="$(redis_command "$get_payload")"
grep -q "$value" <<<"$get_out" || fail "Redis GET did not return expected value"

smoke_log "deleting isolated Redis key"
del_out="$(redis_command "$del_payload")"
grep -q ':1' <<<"$del_out" || fail "Redis DEL did not delete smoke key"

smoke_log "ok redis isolated write/read/delete"
