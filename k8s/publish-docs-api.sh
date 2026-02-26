#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT_DIR/k8s/docs-api.yaml"
NAMESPACE="${NAMESPACE:-joelclaw}"
DEPLOYMENT="${DEPLOYMENT:-docs-api}"
REGISTRY="${REGISTRY:-ghcr.io}"
OWNER="${OWNER:-joelhooks}"
IMAGE_NAME="${IMAGE_NAME:-docs-api}"
TAG="${1:-$(date +%Y%m%d-%H%M%S)}"
IMAGE="$REGISTRY/$OWNER/$IMAGE_NAME:$TAG"
LATEST_IMAGE="$REGISTRY/$OWNER/$IMAGE_NAME:latest"

for cmd in docker kubectl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd is required" >&2
    exit 1
  fi
done

DOCKER_CONFIG_DIR="$(mktemp -d /tmp/docker-ghcr.XXXXXX)"
cleanup() {
  rm -rf "$DOCKER_CONFIG_DIR"
}
trap cleanup EXIT
export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  GH_USER="${GHCR_USER:-$OWNER}"
  echo "Logging in to GHCR as $GH_USER (GHCR_TOKEN)"
  printf "%s" "$GHCR_TOKEN" | docker login "$REGISTRY" -u "$GH_USER" --password-stdin >/dev/null
else
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI is required when GHCR_TOKEN is not set" >&2
    exit 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "gh auth is not configured. Run: gh auth login, or set GHCR_TOKEN" >&2
    exit 1
  fi
  GH_USER="$(gh api user -q .login)"
  echo "Logging in to GHCR as $GH_USER (gh auth token)"
  gh auth token | docker login "$REGISTRY" -u "$GH_USER" --password-stdin >/dev/null
fi

echo "Building $IMAGE"
docker build \
  -f "$ROOT_DIR/apps/docs-api/Dockerfile" \
  -t "$IMAGE" \
  -t "$LATEST_IMAGE" \
  "$ROOT_DIR/apps/docs-api"

echo "Pushing $IMAGE"
docker push "$IMAGE"
echo "Pushing $LATEST_IMAGE"
docker push "$LATEST_IMAGE"

echo "Updating manifest image -> $IMAGE"
if ! grep -q "ghcr.io/.*/docs-api:" "$MANIFEST"; then
  echo "Could not find docs-api image reference in $MANIFEST" >&2
  exit 1
fi
sed -i.bak -E "s|image: ghcr.io/.*/docs-api:[^[:space:]]+|image: $IMAGE|" "$MANIFEST"
rm -f "$MANIFEST.bak"

echo "Applying manifest"
kubectl apply -f "$MANIFEST"

echo "Waiting for rollout"
kubectl -n "$NAMESPACE" rollout status deployment/"$DEPLOYMENT" --timeout=180s

echo "Done"
echo "  image: $IMAGE"
echo "  deployment: $NAMESPACE/$DEPLOYMENT"
