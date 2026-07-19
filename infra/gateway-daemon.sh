#!/bin/bash
set -euo pipefail

export HOME="/Users/joel"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SECRETS_BIN="${SECRETS_BIN:-$HOME/.local/bin/secrets}"
GATEWAY_START="${GATEWAY_START:-$HOME/.joelclaw/scripts/gateway-start.sh}"

[ -x "$SECRETS_BIN" ] || {
  echo "secrets CLI is missing or not executable: $SECRETS_BIN" >&2
  exit 1
}
[ -x "$GATEWAY_START" ] || {
  echo "gateway start script is missing or not executable: $GATEWAY_START" >&2
  exit 1
}

# LaunchDaemons start concurrently at boot. The gateway leases channel tokens
# only once, so do not let it start in a permanently degraded state while the
# secrets daemon is still creating its socket.
for _ in $(seq 1 60); do
  if "$SECRETS_BIN" status --json >/dev/null 2>&1; then
    exec "$GATEWAY_START"
  fi
  sleep 1
done

echo "agent-secrets did not become ready within 60 seconds" >&2
exit 1
