#!/usr/bin/env bash
set -euo pipefail

SECRET_ENV_FILE="${CHORUS_RHIZOMATIC_SECRET_ENV_FILE:-/Users/Shared/joelclaw/secrets/chorus-rhizomatic.env}"
UPSTREAM_ROOT="${RHIZOMATIC_UPSTREAM_ROOT:-/Users/Shared/joelclaw/upstream/rhizomatic}"

if [[ ! -f "$SECRET_ENV_FILE" ]]; then
  echo "missing Chorus Rhizomatic secret env: $SECRET_ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$SECRET_ENV_FILE"

export CHORUS_HTTP_TOKEN CHORUS_MASTER_SEED CHORUS_STORE CHORUS_HTTP_HOST CHORUS_HTTP_PORT
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

cd "$UPSTREAM_ROOT/apps/chorus"
exec ./node_modules/.bin/tsx src/mcp-http.ts
