#!/usr/bin/env bash
set -euo pipefail

RESTATE_CLI_BIN="${RESTATE_CLI_BIN:-restate}"
RESTATE_DEPLOYMENT_ENDPOINT="${RESTATE_DEPLOYMENT_ENDPOINT:-http://host.lima.internal:9080}"
RESTATE_ADMIN_URL="${RESTATE_ADMIN_URL:-http://localhost:9070}"
RESTATE_REGISTER_FORCE="${RESTATE_REGISTER_FORCE:-false}"

if ! command -v "$RESTATE_CLI_BIN" >/dev/null 2>&1; then
  echo "error: $RESTATE_CLI_BIN not found in PATH"
  echo "install restate CLI or run with RESTATE_CLI_BIN=<path-to-restate>"
  exit 1
fi

admin_hostport="${RESTATE_ADMIN_URL#http://}"
admin_hostport="${admin_hostport#https://}"

export RESTATE_HOSTPORT="$admin_hostport"

echo "registering deployment: $RESTATE_DEPLOYMENT_ENDPOINT"
echo "(set RESTATE_DEPLOYMENT_ENDPOINT=http://localhost:9080 if Restate runtime and deployment both run on host)"

register_args=(deployments register "$RESTATE_DEPLOYMENT_ENDPOINT" --yes)
if [[ "$RESTATE_REGISTER_FORCE" == "true" ]]; then
  register_args+=(--force)
fi

"$RESTATE_CLI_BIN" "${register_args[@]}"

echo "listing deployments"
"$RESTATE_CLI_BIN" deployments list

echo "done"
