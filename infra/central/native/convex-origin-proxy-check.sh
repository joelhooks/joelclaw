#!/bin/sh
# Health check for the Convex origin proxy (sec-20261103-003). Every run probes
# each proxy port on loopback; on a change between up and down it sends one
# Rat King message, so a dead proxy alarms once instead of every five minutes.
set -u

STATE_DIR="${CONVEX_PROXY_STATE_DIR:-$HOME/.local/state/convex-origin-proxy}"
PORTS="${CONVEX_PROXY_CHECK_PORTS:-13210}"
ALARM_AS="${CONVEX_PROXY_ALARM_AS:-}"
ALARM_TO="${CONVEX_PROXY_ALARM_TO:-$ALARM_AS}"
RATKING="${RATKING_BIN:-ratking}"

mkdir -p "$STATE_DIR"
status=up
failed=""
for port in $PORTS; do
  if ! curl -fsS --max-time 5 -D - -o /dev/null "http://127.0.0.1:${port}/version" 2>/dev/null | grep -qi "^x-convex-origin-proxy: 1"; then
    status=down
    failed="$failed $port"
  fi
done

previous="$(cat "$STATE_DIR/status" 2>/dev/null || echo unknown)"
printf '%s\n' "$status" >"$STATE_DIR/status"
printf '%s %s%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" "$failed" >>"$STATE_DIR/check.log"

[ "$status" = "$previous" ] && exit 0
[ -n "$ALARM_AS" ] || exit 0
if [ "$status" = down ]; then
  summary="Convex origin proxy DOWN on$failed: tailnet Convex clients fail until it is back."
  body="launchctl kickstart -k gui/\$(id -u)/com.joelclaw.convex-origin-proxy; logs in ~/.local/log/convex-origin-proxy.err"
else
  [ "$previous" = unknown ] && exit 0
  summary="Convex origin proxy back up."
  body="All proxy ports answer /version again."
fi
"$RATKING" send --as "$ALARM_AS" --to "$ALARM_TO" --summary "$summary" --body "$body" >/dev/null 2>&1 || true
exit 0
