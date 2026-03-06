#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

RESTATE_CLI_BIN="${RESTATE_CLI_BIN:-restate}"
RESTATE_ADMIN_LOCAL_PORT="${DAG_RESTATE_ADMIN_LOCAL_PORT:-9070}"
RESTATE_INGRESS_LOCAL_PORT="${DAG_RESTATE_INGRESS_LOCAL_PORT:-8080}"
RESTATE_SERVICE_PORT="${DAG_RESTATE_SERVICE_PORT:-9080}"
RESTATE_DEPLOYMENT_ENDPOINT="${DAG_RESTATE_DEPLOYMENT_ENDPOINT:-http://host.lima.internal:${RESTATE_SERVICE_PORT}}"
DAG_TIMEOUT_SECONDS="${DAG_TIMEOUT_SECONDS:-300}"
DAG_SLEEP_MS="${DAG_SLEEP_MS:-200}"
DAG_WORKFLOW_ID="${DAG_WORKFLOW_ID:-dag-smoke-$(date +%s%N)}"

if ! command -v "$RESTATE_CLI_BIN" >/dev/null 2>&1; then
  echo "error: $RESTATE_CLI_BIN not found in PATH"
  exit 1
fi

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-30}"

  local i=1
  while [[ $i -le $attempts ]]; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      echo "ready: $label"
      return 0
    fi

    sleep 1
    i=$((i + 1))
  done

  echo "error: timed out waiting for $label ($url)"
  return 1
}

SVC_PID=""
PF_RESTATE_PID=""

cleanup() {
  if [[ -n "$SVC_PID" ]]; then
    kill "$SVC_PID" 2>/dev/null || true
  fi

  if [[ -n "$PF_RESTATE_PID" ]]; then
    kill "$PF_RESTATE_PID" 2>/dev/null || true
  fi

  wait 2>/dev/null || true
}
trap cleanup EXIT

echo "[1/5] port-forward Restate service"
kubectl -n joelclaw port-forward svc/restate "${RESTATE_ADMIN_LOCAL_PORT}:9070" "${RESTATE_INGRESS_LOCAL_PORT}:8080" >/tmp/restate-dag-port-forward.log 2>&1 &
PF_RESTATE_PID=$!

wait_for_url "http://localhost:${RESTATE_ADMIN_LOCAL_PORT}/health" "restate admin"

echo "[2/5] start local Restate deployment endpoint"
STALE_PIDS="$(lsof -tiTCP:"${RESTATE_SERVICE_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$STALE_PIDS" ]]; then
  echo "clearing stale listeners on ${RESTATE_SERVICE_PORT}: $STALE_PIDS"
  kill $STALE_PIDS 2>/dev/null || true
  sleep 1
fi

(
  cd "$ROOT_DIR"
  CHANNEL=console RESTATE_PORT="$RESTATE_SERVICE_PORT" bun run packages/restate/src/index.ts
) >/tmp/restate-dag-service.log 2>&1 &
SVC_PID=$!

for i in {1..30}; do
  if ! kill -0 "$SVC_PID" 2>/dev/null; then
    echo "error: local deployment endpoint process exited early"
    exit 1
  fi

  if lsof -nP -iTCP:"${RESTATE_SERVICE_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ready: local deployment endpoint"
    break
  fi

  sleep 1
  if [[ "$i" == "30" ]]; then
    echo "error: local deployment endpoint did not start on ${RESTATE_SERVICE_PORT}"
    exit 1
  fi
done

echo "[3/5] register deployment endpoint"
(
  cd "$ROOT_DIR"
  RESTATE_CLI_BIN="$RESTATE_CLI_BIN" \
  RESTATE_ADMIN_URL="http://localhost:${RESTATE_ADMIN_LOCAL_PORT}" \
  RESTATE_DEPLOYMENT_ENDPOINT="$RESTATE_DEPLOYMENT_ENDPOINT" \
  RESTATE_REGISTER_FORCE=true \
  scripts/restate/register-deployment.sh
) >/tmp/restate-dag-register.log 2>&1

echo "[4/5] invoke dagOrchestrator workflow"
REQUEST_PAYLOAD="$({
  DAG_WORKFLOW_ID="$DAG_WORKFLOW_ID" \
  DAG_SLEEP_MS="$DAG_SLEEP_MS" \
  node -e '
    const id = process.env.DAG_WORKFLOW_ID || "dag-smoke";
    const sleepMs = Number.parseInt(process.env.DAG_SLEEP_MS || "200", 10);
    const safeSleep = Number.isFinite(sleepMs) ? Math.max(0, Math.min(sleepMs, 5000)) : 200;

    const payload = {
      requestId: id,
      nodes: [
        { id: "discover", task: "discover source inputs", simulatedMs: safeSleep },
        { id: "analyze", task: "analyze source inputs", simulatedMs: safeSleep },
        { id: "synthesize", task: "synthesize outputs", dependsOn: ["discover", "analyze"], simulatedMs: safeSleep },
        { id: "publish", task: "publish final artifact", dependsOn: ["synthesize"], simulatedMs: safeSleep },
      ],
    };

    process.stdout.write(JSON.stringify(payload));
  '
})"

RESPONSE="$(curl -fsS --max-time "$DAG_TIMEOUT_SECONDS" "http://localhost:${RESTATE_INGRESS_LOCAL_PORT}/dagOrchestrator/${DAG_WORKFLOW_ID}/run" \
  -H 'content-type: application/json' \
  -d "$REQUEST_PAYLOAD")"

echo "$RESPONSE"

echo "[5/5] validate response"
DAG_WORKFLOW_ID="$DAG_WORKFLOW_ID" \
node -e '
const payload = JSON.parse(process.argv[1]);
const workflowId = process.env.DAG_WORKFLOW_ID;

if (!payload || typeof payload !== "object") {
  throw new Error("expected object response payload");
}

if (payload.workflowId !== workflowId) {
  throw new Error(`expected workflowId=${workflowId}, got ${payload.workflowId}`);
}

if (payload.nodeCount !== 4) {
  throw new Error(`expected nodeCount=4, got ${payload.nodeCount}`);
}

if (payload.waveCount !== 3) {
  throw new Error(`expected waveCount=3, got ${payload.waveCount}`);
}

if (!Array.isArray(payload.waves) || payload.waves.length !== 3) {
  throw new Error("expected exactly 3 waves");
}

const expectedWaves = [
  ["analyze", "discover"],
  ["synthesize"],
  ["publish"],
];

for (let i = 0; i < expectedWaves.length; i += 1) {
  const expected = expectedWaves[i];
  const actual = (payload.waves[i]?.nodeIds ?? []).slice().sort();
  const expectedSorted = expected.slice().sort();

  if (JSON.stringify(actual) !== JSON.stringify(expectedSorted)) {
    throw new Error(`wave ${i} mismatch: expected ${expectedSorted.join(",")}, got ${actual.join(",")}`);
  }

  const resultCount = Array.isArray(payload.waves[i]?.results) ? payload.waves[i].results.length : 0;
  if (resultCount !== expected.length) {
    throw new Error(`wave ${i} result count mismatch: expected ${expected.length}, got ${resultCount}`);
  }
}

console.log(`PASS: DAG workload completed in ${payload.waveCount} waves with ${payload.nodeCount} nodes`);
' "$RESPONSE"
