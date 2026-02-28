#!/bin/bash
set -euo pipefail

export HOME="/Users/joel"
export PATH="/Users/joel/.local/bin:/Users/joel/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p /Users/joel/.local/log
cd /Users/joel/Code/joelhooks/joelclaw/infra/voice-agent

exec /Users/joel/Code/joelhooks/joelclaw/infra/voice-agent/run.sh start
