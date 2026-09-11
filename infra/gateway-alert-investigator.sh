#!/bin/bash
# Start or update the default-Herdr DGX GLM investigator for a gateway alert.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN_BIN="${GATEWAY_ALERT_INVESTIGATOR_BUN_BIN:-$HOME/.bun/bin/bun}"

exec "$BUN_BIN" run "$ROOT/packages/gateway/src/gateway-alert-investigator.ts" "$@"
