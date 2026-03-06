#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

RESTATE_CLI_BIN="${RESTATE_CLI_BIN:-restate}"
RESTATE_ADMIN_LOCAL_PORT="${SMOKE_RESTATE_ADMIN_LOCAL_PORT:-9070}"
RESTATE_INGRESS_LOCAL_PORT="${SMOKE_RESTATE_INGRESS_LOCAL_PORT:-8080}"
RESTATE_SERVICE_PORT="${SMOKE_RESTATE_SERVICE_PORT:-9080}"
RESTATE_DEPLOYMENT_ENDPOINT="${SMOKE_RESTATE_DEPLOYMENT_ENDPOINT:-http://host.lima.internal:${RESTATE_SERVICE_PORT}}"
SMOKE_REASON="${SMOKE_REASON:-restate deployGate smoke validation}"
SMOKE_SKIP_APPROVAL="${SMOKE_SKIP_APPROVAL:-true}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-900}"
SMOKE_TAG="${SMOKE_TAG:-}"
SMOKE_DEPLOY_ID="${SMOKE_DEPLOY_ID:-smoke-$(date +%s%N)}"

if [[ -z "$SMOKE_TAG" ]]; then
  SMOKE_TAG="$(awk '/image: ghcr.io\/.*\/system-bus-worker:/ {split($2, p, ":"); print p[2]; exit}' "${ROOT_DIR}/k8s/system-bus-worker.yaml" || true)"
fi

if [[ -z "$SMOKE_TAG" ]]; then
  SMOKE_TAG="$(date -u +%Y-%m-%dT%H-%M-%S)"
fi

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
kubectl -n joelclaw port-forward svc/restate "${RESTATE_ADMIN_LOCAL_PORT}:9070" "${RESTATE_INGRESS_LOCAL_PORT}:8080" >/tmp/restate-smoke-port-forward.log 2>&1 &
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
) >/tmp/restate-smoke-service.log 2>&1 &
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
) >/tmp/restate-smoke-register.log 2>&1

echo "[4/5] invoke deployGate workflow"
REQUEST_PAYLOAD="$(
  SMOKE_TAG="$SMOKE_TAG" \
  SMOKE_REASON="$SMOKE_REASON" \
  SMOKE_SKIP_APPROVAL="$SMOKE_SKIP_APPROVAL" \
  node -e '
    const payload = {
      tag: process.env.SMOKE_TAG,
      reason: process.env.SMOKE_REASON,
      skipApproval: process.env.SMOKE_SKIP_APPROVAL !== "false",
    };
    process.stdout.write(JSON.stringify(payload));
  '
)"

RESPONSE="$(curl -fsS --max-time "$SMOKE_TIMEOUT_SECONDS" "http://localhost:${RESTATE_INGRESS_LOCAL_PORT}/deployGate/${SMOKE_DEPLOY_ID}/run" \
  -H 'content-type: application/json' \
  -d "$REQUEST_PAYLOAD")"

echo "$RESPONSE"

echo "[5/5] validate response"
SMOKE_TAG="$SMOKE_TAG" \
SMOKE_SKIP_APPROVAL="$SMOKE_SKIP_APPROVAL" \
node -e '
const payload = JSON.parse(process.argv[1]);
const expectedTag = process.env.SMOKE_TAG;
const skipApproval = process.env.SMOKE_SKIP_APPROVAL !== "false";

if (typeof payload !== "object" || payload === null) {
  throw new Error("expected object response payload");
}

if (!payload.image || typeof payload.image !== "string") {
  throw new Error("expected image string in response");
}

if (!payload.image.endsWith(`:${expectedTag}`)) {
  throw new Error(`expected image tag ${expectedTag}, got ${payload.image}`);
}

if (skipApproval && payload.decision !== "skipped") {
  throw new Error(`expected decision=skipped, got ${payload.decision}`);
}

if (payload.rolloutVerified !== true) {
  throw new Error("expected rolloutVerified=true");
}

console.log(`PASS: deployGate completed (${payload.decision}) with rollout verified for ${payload.image}`);
' "$RESPONSE"
