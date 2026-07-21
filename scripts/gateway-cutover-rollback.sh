#!/bin/bash
# Rollback the agent-comms-gateway cutover. Armed for week one after the flip.
# Restores the pre-cutover transport entrypoint and restarts the daemon.
# Usage: scripts/gateway-cutover-rollback.sh [gateway-pane-id]
set -euo pipefail

GATEWAY_START="$HOME/.joelclaw/scripts/gateway-start.sh"
BACKUP="$GATEWAY_START.pre-cutover"
PANE_ID="${1:-}"

echo "[rollback] 1/5 stopping driver"
pkill -f "agent-comms-driver" || echo "[rollback] driver was not running"

if [ -n "$PANE_ID" ]; then
  echo "[rollback] 2/5 retiring gateway session pane $PANE_ID"
  herdr pane close "$PANE_ID" || echo "[rollback] pane close failed or already gone"
else
  echo "[rollback] 2/5 no pane id given; retire the gateway session manually"
fi

echo "[rollback] 3/5 restoring pre-cutover entrypoint"
[ -f "$BACKUP" ] || { echo "FATAL: backup missing: $BACKUP" >&2; exit 1; }
cp "$BACKUP" "$GATEWAY_START"
chmod +x "$GATEWAY_START"

echo "[rollback] 4/5 restarting gateway daemon"
joelclaw gateway restart

echo "[rollback] 5/5 probing restored routing path"
sleep 8
OUT=$(joelclaw notify send "rollback probe: legacy routing restored $(date -Iseconds)" --kind alert 2>&1) || {
  echo "FATAL: probe send failed: $OUT" >&2; exit 1; }
echo "$OUT" | grep -q '"ok"[[:space:]]*:[[:space:]]*true' || { echo "FATAL: probe not ok: $OUT" >&2; exit 1; }
echo "[rollback] complete — verify the probe arrived in Telegram, then confirm receipt in the step file"
