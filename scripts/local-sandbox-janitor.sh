#!/bin/bash
set -euo pipefail

ROOT="/Users/joel/Code/joelhooks/joelclaw"
CLI="/Users/joel/.bun/bin/joelclaw"
LOG_DIR="/tmp/joelclaw"

export HOME="/Users/joel"
export PATH="/Users/joel/.bun/bin:/Users/joel/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOG_DIR"
cd "$ROOT"

if [[ ! -x "$CLI" ]]; then
  echo "[$(date -Iseconds)] joelclaw binary missing at $CLI" >&2
  exit 1
fi

echo "[$(date -Iseconds)] local sandbox janitor tick"
exec "$CLI" workload sandboxes janitor
