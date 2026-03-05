#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

RESTATE_CLI_BIN="${RESTATE_CLI_BIN:-restate}"
RESTATE_ADMIN_LOCAL_PORT="${SMOKE_RESTATE_ADMIN_LOCAL_PORT:-9070}"
RESTATE_INGRESS_LOCAL_PORT="${SMOKE_RESTATE_INGRESS_LOCAL_PORT:-8080}"
RESTATE_SERVICE_PORT="${SMOKE_RESTATE_SERVICE_PORT:-9080}"
RESTATE_DEPLOYMENT_ENDPOINT="${SMOKE_RESTATE_DEPLOYMENT_ENDPOINT:-http://host.lima.internal:${RESTATE_SERVICE_PORT}}"

MINIO_NAMESPACE="${SMOKE_MINIO_NAMESPACE:-${MINIO_NAMESPACE:-joelclaw}}"
MINIO_SERVICE_NAME="${SMOKE_MINIO_SERVICE_NAME:-${MINIO_SERVICE_NAME:-minio}}"
MINIO_LOCAL_PORT="${SMOKE_MINIO_LOCAL_PORT:-${MINIO_LOCAL_PORT:-9000}}"
MINIO_ACCESS_KEY="${SMOKE_MINIO_ACCESS_KEY:-${MINIO_ACCESS_KEY:-minioadmin}}"
MINIO_SECRET_KEY="${SMOKE_MINIO_SECRET_KEY:-${MINIO_SECRET_KEY:-minioadmin}}"
MINIO_USE_SSL="${SMOKE_MINIO_USE_SSL:-${MINIO_USE_SSL:-false}}"
MINIO_BUCKET="${SMOKE_MINIO_BUCKET:-${MINIO_BUCKET:-restate-smoke-tests}}"

if ! command -v "$RESTATE_CLI_BIN" >/dev/null 2>&1; then
  echo "error: $RESTATE_CLI_BIN not found in PATH"
  exit 1
fi

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-30}"
  local insecure="${4:-false}"

  local i=1
  while [[ $i -le $attempts ]]; do
    if [[ "$insecure" == "true" ]]; then
      if curl --insecure -fsS --max-time 2 "$url" >/dev/null 2>&1; then
        echo "ready: $label"
        return 0
      fi
    else
      if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
        echo "ready: $label"
        return 0
      fi
    fi

    sleep 1
    i=$((i + 1))
  done

  echo "error: timed out waiting for $label ($url)"
  return 1
}

SVC_PID=""
PF_RESTATE_PID=""
PF_MINIO_PID=""

cleanup() {
  if [[ -n "$SVC_PID" ]]; then
    kill "$SVC_PID" 2>/dev/null || true
  fi

  if [[ -n "$PF_RESTATE_PID" ]]; then
    kill "$PF_RESTATE_PID" 2>/dev/null || true
  fi

  if [[ -n "$PF_MINIO_PID" ]]; then
    kill "$PF_MINIO_PID" 2>/dev/null || true
  fi

  wait 2>/dev/null || true
}
trap cleanup EXIT

echo "[1/6] port-forward Restate service"
kubectl -n joelclaw port-forward svc/restate "${RESTATE_ADMIN_LOCAL_PORT}:9070" "${RESTATE_INGRESS_LOCAL_PORT}:8080" >/tmp/restate-smoke-port-forward.log 2>&1 &
PF_RESTATE_PID=$!

echo "[2/6] port-forward MinIO service (${MINIO_NAMESPACE}/${MINIO_SERVICE_NAME})"
kubectl -n "$MINIO_NAMESPACE" port-forward "svc/${MINIO_SERVICE_NAME}" "${MINIO_LOCAL_PORT}:9000" >/tmp/restate-smoke-minio-port-forward.log 2>&1 &
PF_MINIO_PID=$!

wait_for_url "http://localhost:${RESTATE_ADMIN_LOCAL_PORT}/health" "restate admin"

MINIO_SCHEME="http"
MINIO_HEALTH_INSECURE="false"
if [[ "$MINIO_USE_SSL" == "true" ]]; then
  MINIO_SCHEME="https"
  MINIO_HEALTH_INSECURE="true"
fi

if ! wait_for_url "${MINIO_SCHEME}://localhost:${MINIO_LOCAL_PORT}/minio/health/ready" "minio" 30 "$MINIO_HEALTH_INSECURE"; then
  if [[ "$MINIO_NAMESPACE" == "joelclaw" && "$MINIO_SERVICE_NAME" == "minio" ]]; then
    echo "default MinIO unavailable; falling back to aistor/aistor-s3-api"

    kill "$PF_MINIO_PID" 2>/dev/null || true
    MINIO_NAMESPACE="aistor"
    MINIO_SERVICE_NAME="aistor-s3-api"
    MINIO_LOCAL_PORT="39000"
    MINIO_USE_SSL="true"
    MINIO_SCHEME="https"
    MINIO_HEALTH_INSECURE="true"

    kubectl -n "$MINIO_NAMESPACE" port-forward "svc/${MINIO_SERVICE_NAME}" "${MINIO_LOCAL_PORT}:9000" >/tmp/restate-smoke-minio-port-forward.log 2>&1 &
    PF_MINIO_PID=$!

    wait_for_url "${MINIO_SCHEME}://localhost:${MINIO_LOCAL_PORT}/minio/health/ready" "aistor" 30 "$MINIO_HEALTH_INSECURE"
  else
    exit 1
  fi
fi

echo "[3/6] start local Restate deployment endpoint"
STALE_PIDS="$(lsof -tiTCP:"${RESTATE_SERVICE_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$STALE_PIDS" ]]; then
  echo "clearing stale listeners on ${RESTATE_SERVICE_PORT}: $STALE_PIDS"
  kill $STALE_PIDS 2>/dev/null || true
  sleep 1
fi

(
  cd "$ROOT_DIR"

  if [[ "$MINIO_USE_SSL" == "true" ]]; then
    export NODE_TLS_REJECT_UNAUTHORIZED=0
  fi

  MINIO_ENDPOINT=localhost \
  MINIO_PORT="$MINIO_LOCAL_PORT" \
  MINIO_USE_SSL="$MINIO_USE_SSL" \
  MINIO_ACCESS_KEY="$MINIO_ACCESS_KEY" \
  MINIO_SECRET_KEY="$MINIO_SECRET_KEY" \
  MINIO_BUCKET="$MINIO_BUCKET" \
  RESTATE_PORT="$RESTATE_SERVICE_PORT" \
  bun run packages/restate/src/index.ts
) >/tmp/restate-smoke-service.log 2>&1 &
SVC_PID=$!

for i in {1..20}; do
  if ! kill -0 "$SVC_PID" 2>/dev/null; then
    echo "error: local deployment endpoint process exited early"
    exit 1
  fi

  if lsof -nP -iTCP:"${RESTATE_SERVICE_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ready: local deployment endpoint"
    break
  fi

  sleep 1
  if [[ "$i" == "20" ]]; then
    echo "error: local deployment endpoint did not start on ${RESTATE_SERVICE_PORT}"
    exit 1
  fi
done

echo "[4/6] register deployment endpoint"
(
  cd "$ROOT_DIR"
  RESTATE_CLI_BIN="$RESTATE_CLI_BIN" \
  RESTATE_ADMIN_URL="http://localhost:${RESTATE_ADMIN_LOCAL_PORT}" \
  RESTATE_DEPLOYMENT_ENDPOINT="$RESTATE_DEPLOYMENT_ENDPOINT" \
  RESTATE_REGISTER_FORCE=true \
  scripts/restate/register-deployment.sh
) >/tmp/restate-smoke-register.log 2>&1

echo "[5/6] invoke orchestrator workflow"
NONCE="$(date +%s%N)"
REQUEST_PAYLOAD="[\"alpha-${NONCE}\",\"beta-${NONCE}\",\"gamma-${NONCE}\"]"
RESPONSE="$(curl -fsS --max-time 45 "http://localhost:${RESTATE_INGRESS_LOCAL_PORT}/orchestratorService/runBatch" \
  -H 'content-type: application/json' \
  -d "$REQUEST_PAYLOAD")"

echo "$RESPONSE"

echo "[6/6] validate response"
node -e '
const payload = JSON.parse(process.argv[1]);
if (payload.completedCount !== 3) {
  throw new Error(`expected completedCount=3, got ${payload.completedCount}`);
}
if (!payload.artifact || payload.artifact.storage !== "minio") {
  throw new Error("expected artifact.storage=minio");
}
if (payload.artifact.roundTripMatches !== true) {
  throw new Error("expected artifact.roundTripMatches=true");
}
console.log("PASS: Restate orchestrator completed with MinIO artifact round-trip");
' "$RESPONSE"
