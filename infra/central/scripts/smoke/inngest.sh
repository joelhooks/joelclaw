#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_smoke_command curl
require_smoke_command jq
require_secret_env INNGEST_EVENT_KEY

base="http://${CENTRAL_BIND_ADDR}:8288"
event_id="$(smoke_id):inngest"

smoke_log "checking Inngest health"
http_ok "${base}/health"

smoke_log "sending isolated smoke event"
payload="$(jq -n --arg id "$event_id" '{name:"central/smoke.test", id:$id, data:{source:"flagg-gate5-smoke", isolated:true}}')"
response="$(curl -fsS --max-time 10 \
  -X POST \
  -H 'Content-Type: application/json' \
  --data-binary "$payload" \
  "${base}/e/${INNGEST_EVENT_KEY}")"

if jq -e '.ids? or .id? or .status? or .ok?' <<<"$response" >/dev/null 2>&1; then
  smoke_log "ok inngest accepted isolated smoke event"
else
  fail "Inngest event response was not recognized"
fi
