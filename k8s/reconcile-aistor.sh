#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

OPERATOR_RELEASE="${AISTOR_OPERATOR_RELEASE:-aistor}"
OPERATOR_NAMESPACE="${AISTOR_OPERATOR_NAMESPACE:-aistor}"
OBJECTSTORE_RELEASE="${AISTOR_OBJECTSTORE_RELEASE:-aistor-primary}"
OBJECTSTORE_NAMESPACE="${AISTOR_OBJECTSTORE_NAMESPACE:-aistor}"
OBJECTSTORE_NAME="${AISTOR_OBJECTSTORE_NAME:-aistor-s3}"
CONFIG_SECRET_NAME="${AISTOR_CONFIG_SECRET_NAME:-aistor-env-configuration}"

OPERATOR_VALUES_FILE="${AISTOR_OPERATOR_VALUES_FILE:-$ROOT_DIR/aistor-operator-values.yaml}"
OBJECTSTORE_VALUES_FILE="${AISTOR_OBJECTSTORE_VALUES_FILE:-$ROOT_DIR/aistor-objectstore-values.yaml}"

ROOT_USER="${AISTOR_ROOT_USER:-minioadmin}"
ROOT_PASSWORD="${AISTOR_ROOT_PASSWORD:-minioadmin}"
AISTOR_LICENSE="${AISTOR_LICENSE:-}"

if [[ "$OBJECTSTORE_NAMESPACE" == "joelclaw" && "${AISTOR_ALLOW_JOELCLAW_NAMESPACE:-false}" != "true" ]]; then
  echo "error: refusing to deploy AIStor objectstore into namespace 'joelclaw' by default" >&2
  echo "reason: service-name collisions can hijack svc/minio during parallel migration" >&2
  echo "override: set AISTOR_ALLOW_JOELCLAW_NAMESPACE=true for intentional cutover" >&2
  exit 1
fi

if ! command -v helm >/dev/null 2>&1; then
  echo "error: helm is required" >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "error: kubectl is required" >&2
  exit 1
fi

if [[ ! -f "$OPERATOR_VALUES_FILE" ]]; then
  echo "error: missing operator values file: $OPERATOR_VALUES_FILE" >&2
  exit 1
fi

if [[ ! -f "$OBJECTSTORE_VALUES_FILE" ]]; then
  echo "error: missing objectstore values file: $OBJECTSTORE_VALUES_FILE" >&2
  exit 1
fi

if [[ -z "$AISTOR_LICENSE" ]]; then
  if ! command -v secrets >/dev/null 2>&1; then
    echo "error: secrets CLI required to lease aistor_key" >&2
    exit 1
  fi

  AISTOR_LICENSE="$(secrets lease aistor_key --ttl 30m)"
fi

echo "[1/6] ensure Helm repo"
helm repo add minio https://helm.min.io >/dev/null 2>&1 || true
helm repo update >/dev/null

echo "[2/6] deploy AIStor operator"
helm upgrade --install "$OPERATOR_RELEASE" minio/aistor-operator \
  -n "$OPERATOR_NAMESPACE" \
  --create-namespace \
  -f "$OPERATOR_VALUES_FILE" \
  --set license="$AISTOR_LICENSE" \
  --wait \
  --timeout 5m

echo "[3/6] ensure objectstore namespace"
kubectl create namespace "$OBJECTSTORE_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "[4/6] apply objectstore runtime secret"
cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: v1
kind: Secret
metadata:
  name: $CONFIG_SECRET_NAME
  namespace: $OBJECTSTORE_NAMESPACE
type: Opaque
stringData:
  config.env: |-
    export MINIO_ROOT_USER=$ROOT_USER
    export MINIO_ROOT_PASSWORD=$ROOT_PASSWORD
EOF

echo "[5/6] deploy AIStor objectstore"
helm upgrade --install "$OBJECTSTORE_RELEASE" minio/aistor-objectstore \
  -n "$OBJECTSTORE_NAMESPACE" \
  --create-namespace \
  -f "$OBJECTSTORE_VALUES_FILE" \
  --wait \
  --timeout 5m

echo "[6/6] wait for objectstore statefulset and show endpoints"
TARGET_STS="${OBJECTSTORE_NAME}-pool-0"

for _ in {1..30}; do
  if kubectl get statefulset "$TARGET_STS" -n "$OBJECTSTORE_NAMESPACE" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! kubectl get statefulset "$TARGET_STS" -n "$OBJECTSTORE_NAMESPACE" >/dev/null 2>&1; then
  echo "error: expected statefulset $TARGET_STS not found in namespace $OBJECTSTORE_NAMESPACE" >&2
  exit 1
fi

kubectl rollout status statefulset/"$TARGET_STS" -n "$OBJECTSTORE_NAMESPACE" --timeout=5m
kubectl get svc -n "$OBJECTSTORE_NAMESPACE" | (head -n 1; rg "$OBJECTSTORE_NAME|NAME" || true)

printf "\nAIStor deploy complete.\n"
printf "S3 NodePort: 31000\n"
printf "Console NodePort: 31001\n"
