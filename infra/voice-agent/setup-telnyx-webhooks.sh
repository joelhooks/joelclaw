#!/usr/bin/env bash
set -euo pipefail

lease() {
  local value
  value="$(secrets lease "$1" --ttl 5m)" || { echo "FATAL: lease failed for $1" >&2; exit 1; }
  case "$value" in '{'*|'') echo "FATAL: bad lease for $1" >&2; exit 1;; esac
  printf '%s' "$value"
}

API_KEY="$(lease telnyx_api_key)"
curl -fsS -X PATCH \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"webhook_event_url":"https://hooks.joelclaw.com/webhooks/telnyx","webhook_api_version":"2"}' \
  https://api.telnyx.com/v2/fqdn_connections/3002093382945212121
printf '\nSet TELNYX_PUBLIC_KEY in the host worker environment, then restart and re-register it.\n'
