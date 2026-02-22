#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required"
  exit 1
fi

if ! command -v joelclaw >/dev/null 2>&1; then
  echo "joelclaw CLI is required"
  exit 1
fi

if ! command -v uuidgen >/dev/null 2>&1; then
  echo "uuidgen is required"
  exit 1
fi

WORKER_URL="${OTEL_WORKER_URL:-http://localhost:3111/observability/emit}"
SOURCE="${1:-verification}"
COMPONENT="${2:-o11y-skill}"
ACTION="${3:-probe.emit}"
LEVEL="${OTEL_LEVEL:-error}"
HOURS="${OTEL_WINDOW_HOURS:-1}"

case "$LEVEL" in
  debug|info|warn|error|fatal) ;;
  *)
    echo "Invalid OTEL_LEVEL: $LEVEL"
    exit 2
    ;;
esac

EVENT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
TIMESTAMP_MS="$(( $(date +%s) * 1000 ))"

PAYLOAD="$(
  jq -nc \
    --arg id "$EVENT_ID" \
    --argjson ts "$TIMESTAMP_MS" \
    --arg level "$LEVEL" \
    --arg source "$SOURCE" \
    --arg component "$COMPONENT" \
    --arg action "$ACTION" \
    '{
      id: $id,
      timestamp: $ts,
      level: $level,
      source: $source,
      component: $component,
      action: $action,
      success: false,
      error: "o11y_skill_smoke_probe",
      metadata: {
        probe: "skills/o11y-logging/scripts/otel-smoke.sh"
      }
    }'
)"

curl_args=(
  -sS
  -X POST
  "$WORKER_URL"
  -H "content-type: application/json"
  --data "$PAYLOAD"
)

if [[ -n "${OTEL_EMIT_TOKEN:-}" ]]; then
  curl_args+=(-H "x-otel-emit-token: ${OTEL_EMIT_TOKEN}")
fi

RESPONSE="$(curl "${curl_args[@]}")"

if ! echo "$RESPONSE" | jq -e '.ok == true' >/dev/null; then
  echo "Emit failed:"
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
  exit 1
fi

if ! echo "$RESPONSE" | jq -e '.result.stored == true and .result.typesense.written == true' >/dev/null; then
  echo "Emit did not store to Typesense:"
  echo "$RESPONSE" | jq .
  exit 1
fi

if [[ "$LEVEL" == "warn" || "$LEVEL" == "error" || "$LEVEL" == "fatal" ]]; then
  if ! echo "$RESPONSE" | jq -e '.result.convex.written == true' >/dev/null; then
    echo "High-severity emit did not mirror to Convex:"
    echo "$RESPONSE" | jq .
    exit 1
  fi
fi

LIST_OUTPUT="$(joelclaw otel list --source "$SOURCE" --component "$COMPONENT" --hours "$HOURS" --limit 20)"
if ! echo "$LIST_OUTPUT" | grep -q "$EVENT_ID"; then
  echo "Event not visible via joelclaw otel list. Event ID: $EVENT_ID"
  exit 1
fi

echo "PASS: OTEL smoke verified"
echo "  event_id: $EVENT_ID"
echo "  source: $SOURCE"
echo "  component: $COMPONENT"
echo "  action: $ACTION"
