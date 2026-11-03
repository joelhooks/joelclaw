#!/bin/sh
# Installs the Convex origin proxy as user LaunchAgents and moves the tailnet
# Serve forwards for 3210/3211 onto it. No sudo. Undo: see --uninstall.
#   CONVEX_PROXY_ALARM_AS=<sender name> CONVEX_PROXY_ALARM_TO=<desk> ./install-convex-origin-proxy.sh
#   ./install-convex-origin-proxy.sh --uninstall
# The Origin allowlist lives outside the repo, in
# ~/.config/joelclaw/convex-origin-proxy.json ({"allowedOrigins": [...]}).
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DEST="$HOME/.local/share/joelclaw/convex-origin-proxy"
CONFIG="$HOME/.config/joelclaw/convex-origin-proxy.json"
AGENTS="$HOME/Library/LaunchAgents"
UID_DOMAIN="gui/$(id -u)"
NODE="${NODE_BIN:-$(command -v node)}"
PROXY_LABEL=com.joelclaw.convex-origin-proxy
CHECK_LABEL=com.joelclaw.convex-origin-proxy-check

if [ "${1:-}" = "--uninstall" ]; then
  tailscale serve --bg --tcp 3210 tcp://127.0.0.1:3210
  tailscale serve --bg --tcp 3211 tcp://127.0.0.1:3211
  launchctl bootout "$UID_DOMAIN/$CHECK_LABEL" 2>/dev/null || true
  launchctl bootout "$UID_DOMAIN/$PROXY_LABEL" 2>/dev/null || true
  echo "Serve forwards point straight at Convex again; LaunchAgents unloaded (plists left in place)."
  exit 0
fi

for port in 13210 13211; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -v "convex-origin-proxy" | grep -q LISTEN && ! curl -fsS --max-time 2 -D - -o /dev/null "http://127.0.0.1:$port/version" 2>/dev/null | grep -qi "^x-convex-origin-proxy: 1"; then
    echo "port $port is held by something else; refusing" >&2; exit 1
  fi
done
[ -f "$CONFIG" ] || { echo "missing $CONFIG: write {\"allowedOrigins\": [...]} first" >&2; exit 1; }
mkdir -p "$DEST" "$HOME/.local/log"
cp "$SCRIPT_DIR/convex-origin-proxy.mjs" "$SCRIPT_DIR/convex-origin-proxy-check.sh" "$DEST/"
chmod 755 "$DEST/convex-origin-proxy-check.sh"

plist() {
  python3 - "$@" <<'PY'
import plistlib, sys
label, out, interval, *args = sys.argv[1:]
env = dict(a.split("=", 1) for a in args if "=" in a and not a.startswith("/"))
prog = [a for a in args if not ("=" in a and not a.startswith("/"))]
p = {"Label": label, "ProgramArguments": prog, "RunAtLoad": True, "ProcessType": "Background",
     "EnvironmentVariables": env, "StandardOutPath": out + ".log", "StandardErrorPath": out + ".err"}
if interval == "0":
    p["KeepAlive"] = True
    p["ThrottleInterval"] = 5
else:
    p["StartInterval"] = int(interval)
with open(f"{__import__('os').path.expanduser('~')}/Library/LaunchAgents/{label}.plist", "wb") as f:
    plistlib.dump(p, f)
PY
}

plist "$PROXY_LABEL" "$HOME/.local/log/convex-origin-proxy" 0 \
  "$NODE" "$DEST/convex-origin-proxy.mjs" \
  "CONVEX_PROXY_ROUTES=13210:3210,13211:3211" "CONVEX_PROXY_ALLOWED_ORIGINS_FILE=$CONFIG"
plist "$CHECK_LABEL" "$HOME/.local/log/convex-origin-proxy-check" 300 \
  /bin/sh "$DEST/convex-origin-proxy-check.sh" \
  "PATH=$(dirname "$NODE"):/opt/homebrew/bin:/usr/bin:/bin" "CONVEX_PROXY_CHECK_PORTS=13210 13211" \
  "CONVEX_PROXY_ALARM_AS=${CONVEX_PROXY_ALARM_AS:-}" "CONVEX_PROXY_ALARM_TO=${CONVEX_PROXY_ALARM_TO:-}"

launchctl bootout "$UID_DOMAIN/$CHECK_LABEL" 2>/dev/null || true
launchctl bootout "$UID_DOMAIN/$PROXY_LABEL" 2>/dev/null || true
sleep 2
launchctl bootstrap "$UID_DOMAIN" "$AGENTS/$PROXY_LABEL.plist"

i=0
proxy_ready() {
  for port in 13210 13211; do
    curl -fsS --max-time 2 -D - -o /dev/null "http://127.0.0.1:$port/version" 2>/dev/null | grep -qi "^x-convex-origin-proxy: 1" || return 1
  done
}
until proxy_ready; do
  i=$((i + 1)); [ "$i" -lt 20 ] || { echo "proxy did not come up; Serve left unchanged" >&2; exit 1; }
  sleep 0.5
done
tailscale serve --bg --tcp 3210 tcp://127.0.0.1:13210
tailscale serve --bg --tcp 3211 tcp://127.0.0.1:13211
# The check loads last, so its run-at-load sees a ready proxy and does not alarm.
launchctl bootstrap "$UID_DOMAIN" "$AGENTS/$CHECK_LABEL.plist"
echo "proxy up; tailnet 3210/3211 now go through it"
