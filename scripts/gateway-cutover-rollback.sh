#!/bin/bash
# Rollback the agent-comms-gateway cutover. Armed for week one after the flip.
# Restores the pre-cutover transport entrypoint and restarts the daemon.
# Usage: scripts/gateway-cutover-rollback.sh [gateway-pane-id]
set -euo pipefail

GATEWAY_START="$HOME/.joelclaw/scripts/gateway-start.sh"
BACKUP="$GATEWAY_START.pre-cutover"
PANE_ID="${1:-}"
HERDR_SESSION="${GATEWAY_HERDR_SESSION:-system}"
DRIVER_LABEL="com.joelclaw.agent-comms-driver"
DRIVER_DOMAIN="gui/$(id -u)"

[ -n "$PANE_ID" ] || {
  echo "FATAL: usage: $0 <verified-system-gateway-pane-id>" >&2
  exit 64
}
[ -f "$BACKUP" ] || { echo "FATAL: backup missing: $BACKUP" >&2; exit 1; }
herdr --session "$HERDR_SESSION" pane get "$PANE_ID" >/dev/null || {
  echo "FATAL: gateway pane is not present in Herdr session $HERDR_SESSION: $PANE_ID" >&2
  exit 1
}

echo "[rollback] 1/5 stopping supervised driver"
launchctl bootout "${DRIVER_DOMAIN}/${DRIVER_LABEL}" >/dev/null 2>&1 || true
if launchctl print "${DRIVER_DOMAIN}/${DRIVER_LABEL}" >/dev/null 2>&1; then
  echo "FATAL: driver LaunchAgent is still loaded" >&2
  exit 1
fi

echo "[rollback] 2/5 retiring gateway session pane $PANE_ID"
herdr --session "$HERDR_SESSION" pane close "$PANE_ID"
if herdr --session "$HERDR_SESSION" pane list \
  | jq -e '.result.panes[]? | select(.label == "📨 gateway loop")' >/dev/null; then
  echo "FATAL: a gateway pane is still live in Herdr session $HERDR_SESSION" >&2
  exit 1
fi

echo "[rollback] 3/5 restoring pre-cutover entrypoint"
cp "$BACKUP" "$GATEWAY_START"
chmod +x "$GATEWAY_START"

echo "[rollback] 4/5 restarting gateway daemon"
joelclaw gateway restart

echo "[rollback] 5/5 probing restored routing path"
sleep 8
OUT=$(joelclaw notify send "rollback probe: legacy routing restored $(date -Iseconds)" --kind alert 2>&1) || {
  echo "FATAL: probe send failed: $OUT" >&2; exit 1; }
echo "$OUT" | grep -q '"ok"[[:space:]]*:[[:space:]]*true' || { echo "FATAL: probe not ok: $OUT" >&2; exit 1; }
echo "[rollback] complete. Verify the probe arrived in Telegram, then confirm receipt in the step file."
