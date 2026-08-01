#!/bin/sh
# docs-api (pdf-brain REST API) on flagg :3838 — supervised by com.joelclaw.docs-api.
# Replaces the retired panda k8s deployment (scaled to 0 in the books-node migration).
set -eu

export HOME="${HOME:-/Users/joel}"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO="$HOME/Code/joelhooks/joelclaw"
ENV_FILE="$HOME/.config/system-bus.env"

# TYPESENSE_API_KEY + DOCS_TYPESENSE_URL come from the env file.
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

# API auth token comes from the local secrets store; never logged.
if [ -z "${PDF_BRAIN_API_TOKEN:-}" ] && command -v secrets >/dev/null 2>&1; then
  PDF_BRAIN_API_TOKEN="$(secrets lease pdf_brain_api_token --ttl 24h 2>/dev/null || true)"
  export PDF_BRAIN_API_TOKEN
fi

export PORT="${PORT:-3838}"
export DOCS_ARTIFACTS_DIR="${DOCS_ARTIFACTS_DIR:-/Volumes/three-body/docs-artifacts}"

cd "$REPO"
exec "$HOME/.bun/bin/bun" run apps/docs-api/src/index.ts
