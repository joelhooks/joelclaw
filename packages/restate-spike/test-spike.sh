#!/bin/bash
set -euo pipefail

RESTATE_PID=""
SVC_PID=""
RESTATE_LOG="/tmp/restate-spike-server.log"
SVC_LOG="/tmp/restate-spike-service.log"

cleanup() {
  echo ""
  echo "Cleaning up..."
  if [[ -n "${SVC_PID}" ]]; then
    kill "${SVC_PID}" 2>/dev/null || true
  fi
  if [[ -n "${RESTATE_PID}" ]]; then
    kill "${RESTATE_PID}" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  echo "Done!"
  echo "Logs: ${RESTATE_LOG}, ${SVC_LOG}"
}
trap cleanup EXIT

echo "Starting Restate server..."
restate-server >"${RESTATE_LOG}" 2>&1 &
RESTATE_PID=$!
sleep 2

echo "Starting service..."
bun run packages/restate-spike/src/index.ts >"${SVC_LOG}" 2>&1 &
SVC_PID=$!
sleep 2

echo "Registering service with Restate..."
restate deployments register http://localhost:9080 --yes

echo ""
echo "=== Test 1: Simple durable chain ==="
curl -s localhost:8080/greeter/greet -H 'content-type: application/json' -d '"World"' | jq .

echo ""
echo "=== Test 2: Fan-out/fan-in ==="
curl -s localhost:8080/orchestrator/fanOut -H 'content-type: application/json' -d '["research-a","research-b","research-c"]' | jq .

echo ""
echo "=== Test 3: Workflow with signal ==="
# Start workflow
curl -s localhost:8080/approvalWorkflow/my-request-1/run/send -H 'content-type: application/json' -d '"deploy to prod"' | jq .
sleep 1
# Send approval signal
curl -s localhost:8080/approvalWorkflow/my-request-1/approve/send -H 'content-type: application/json' -d '"approved by joel"' | jq .
sleep 2
# Get result
curl -s localhost:8080/restate/workflow/approvalWorkflow/my-request-1/output | jq .
