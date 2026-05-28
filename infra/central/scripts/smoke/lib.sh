#!/usr/bin/env bash
set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "${SMOKE_DIR}/../common.sh"

smoke_id() {
  printf 'joelclaw_smoke_%s_%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$$"
}

smoke_log() {
  printf '[smoke:%s] %s\n' "$(basename "$0" .sh)" "$*"
}

require_smoke_command() {
  require_command "$1"
}

require_secret_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" || "$value" == replace-with-* ]]; then
    fail "${name} is required for this smoke test; run as ${SERVICE_USER} from the service checkout or export it explicitly"
  fi
}

http_ok() {
  local url="$1"
  curl -fsS --max-time 5 "$url" >/dev/null
}

http_json() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS --max-time 10 \
      -X "$method" \
      -H 'Content-Type: application/json' \
      --data-binary "$body" \
      "$url"
  else
    curl -fsS --max-time 10 -X "$method" "$url"
  fi
}

load_env_if_present
