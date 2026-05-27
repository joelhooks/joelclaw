#!/usr/bin/env bash
set -euo pipefail

status=0

probe() {
  local label="$1"
  shift
  if "$@" >/tmp/verify-system-tailscaled.$$ 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'fail %s\n' "$label"
    while IFS= read -r line; do
      printf '     %s\n' "$line"
    done < /tmp/verify-system-tailscaled.$$
    status=1
  fi
  rm -f /tmp/verify-system-tailscaled.$$
}

warn_probe() {
  local label="$1"
  shift
  if "$@" >/tmp/verify-system-tailscaled.$$ 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'warn %s\n' "$label"
    while IFS= read -r line; do
      printf '     %s\n' "$line"
    done < /tmp/verify-system-tailscaled.$$
  fi
  rm -f /tmp/verify-system-tailscaled.$$
}

system_label_loaded() {
  launchctl print system/com.tailscale.tailscaled
}

no_gui_app_process() {
  ! pgrep -x Tailscale >/dev/null 2>&1
}

network_extension_absent_or_idle() {
  ! pgrep -f 'io.tailscale.ipn.macsys.network-extension' >/dev/null 2>&1
}

tailscale_running() {
  tailscale status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("BackendState") == "Running", d.get("BackendState"); assert d.get("Self", {}).get("Online") is True'
}

tailscale_ip_present() {
  tailscale ip -4 | grep -Eq '^100\.'
}

local_ssh_works() {
  nc -vz 127.0.0.1 22
}

printf 'Flagg system tailscaled verification\n'
probe 'system LaunchDaemon com.tailscale.tailscaled loaded' system_label_loaded
probe 'tailscale backend running and online' tailscale_running
probe 'tailscale has IPv4 address' tailscale_ip_present
probe 'local SSH listener works' local_ssh_works
probe 'GUI Tailscale.app process not running' no_gui_app_process
warn_probe 'GUI network extension not running' network_extension_absent_or_idle

exit "$status"
