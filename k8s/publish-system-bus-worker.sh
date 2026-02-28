#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT_DIR/k8s/system-bus-worker.yaml"
NAMESPACE="${NAMESPACE:-joelclaw}"
DEPLOYMENT="${DEPLOYMENT:-system-bus-worker}"
REGISTRY="${REGISTRY:-ghcr.io}"
OWNER="${OWNER:-joelhooks}"
IMAGE_NAME="${IMAGE_NAME:-system-bus-worker}"
TAG="${1:-$(date +%Y%m%d-%H%M%S)}"
IMAGE="$REGISTRY/$OWNER/$IMAGE_NAME:$TAG"
LATEST_IMAGE="$REGISTRY/$OWNER/$IMAGE_NAME:latest"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi
if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh auth is not configured. Run: gh auth login" >&2
  exit 1
fi

DOCKER_CONFIG_DIR="$(mktemp -d /tmp/docker-ghcr.XXXXXX)"
cleanup() {
  rm -rf "$DOCKER_CONFIG_DIR"
}
trap cleanup EXIT
export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"

GH_USER="$(gh api user -q .login)"

auth_source="gh auth token"
ghcr_token="${GHCR_TOKEN:-}"

if [[ -z "$ghcr_token" ]] && command -v secrets >/dev/null 2>&1; then
  if ghcr_token="$(secrets lease ghcr_pat --ttl 20m --client-id publish-system-bus-worker 2>/dev/null)"; then
    auth_source="agent-secrets:ghcr_pat"
  fi
fi

echo "Logging in to GHCR as $GH_USER ($auth_source)"
if [[ -n "$ghcr_token" ]]; then
  printf '%s' "$ghcr_token" | docker login "$REGISTRY" -u "$GH_USER" --password-stdin >/dev/null
else
  gh auth token | docker login "$REGISTRY" -u "$GH_USER" --password-stdin >/dev/null
fi

echo "Building $IMAGE"
docker build \
  -f "$ROOT_DIR/packages/system-bus/Dockerfile" \
  -t "$IMAGE" \
  -t "$LATEST_IMAGE" \
  "$ROOT_DIR"

echo "Pushing $IMAGE"
docker push "$IMAGE"
echo "Pushing $LATEST_IMAGE"
docker push "$LATEST_IMAGE"

echo "Updating manifest image -> $IMAGE"
if ! grep -q "ghcr.io/.*/system-bus-worker:" "$MANIFEST"; then
  echo "Could not find system-bus-worker image reference in $MANIFEST" >&2
  exit 1
fi
sed -i.bak -E "s|image: ghcr.io/.*/system-bus-worker:[^[:space:]]+|image: $IMAGE|" "$MANIFEST"
rm -f "$MANIFEST.bak"

echo "Applying manifest"
kubectl apply -f "$MANIFEST"

echo "Waiting for rollout"
kubectl -n "$NAMESPACE" rollout status deployment/"$DEPLOYMENT" --timeout=180s

echo "Worker probe"
POD="$(kubectl -n "$NAMESPACE" get pods -l app=$DEPLOYMENT -o jsonpath='{.items[0].metadata.name}')"
kubectl -n "$NAMESPACE" exec "$POD" -- bun -e 'const r=await fetch("http://127.0.0.1:3111/"); console.log(await r.text());' || true

echo "Done"
echo "  image: $IMAGE"
echo "  deployment: $NAMESPACE/$DEPLOYMENT"
