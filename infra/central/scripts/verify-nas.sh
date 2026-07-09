#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

WRITE_PROBE=0
BENCHMARK_MIB="${NAS_BENCHMARK_MIB:-64}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --write-probe)
      WRITE_PROBE=1
      shift
      ;;
    --benchmark-mib)
      BENCHMARK_MIB="${2:?missing MiB value}"
      shift 2
      ;;
    *)
      fail "usage: $0 [--write-probe] [--benchmark-mib MIB]"
      ;;
  esac
done

status=0

probe() {
  local label="$1"
  shift
  local tmp
  tmp="$(mktemp -t central-nas-verify.XXXXXX)"
  if "$@" >"$tmp" 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'fail %s\n' "$label"
    while IFS= read -r line; do
      printf '     %s\n' "$line"
    done <"$tmp"
    status=1
  fi
  rm -f "$tmp"
}

warn_probe() {
  local label="$1"
  shift
  local tmp
  tmp="$(mktemp -t central-nas-verify.XXXXXX)"
  if "$@" >"$tmp" 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'warn %s\n' "$label"
    while IFS= read -r line; do
      printf '     %s\n' "$line"
    done <"$tmp"
  fi
  rm -f "$tmp"
}

nc_ok() {
  nc -z -G 3 "$NAS_IP" 2049 >/dev/null 2>&1 || nc -z -w 3 "$NAS_IP" 2049 >/dev/null 2>&1
}

route_field() {
  local field="$1"
  route -n get "$NAS_IP" 2>/dev/null | awk -v field="$field" '$1 == field":" {print $2; exit}'
}

route_mtu() {
  route -n get "$NAS_IP" 2>/dev/null | awk '
    / mtu / || $0 ~ /^[[:space:]]*recvpipe[[:space:]]+sendpipe/ {seen=1; next}
    seen && NF >= 7 {print $(NF-1); exit}
  '
}

route_uses_expected_interface() {
  local iface
  iface="$(route_field interface)"
  [[ "$iface" == "$NAS_EXPECTED_INTERFACE" ]] || {
    printf 'route interface=%s expected=%s\n' "${iface:-unknown}" "$NAS_EXPECTED_INTERFACE"
    return 1
  }
}

route_mtu_matches() {
  [[ -z "$NAS_EXPECTED_MTU" || "$NAS_EXPECTED_MTU" == "0" ]] && return 0
  local mtu
  mtu="$(route_mtu)"
  [[ "$mtu" == "$NAS_EXPECTED_MTU" ]] || {
    printf 'route mtu=%s expected=%s\n' "${mtu:-unknown}" "$NAS_EXPECTED_MTU"
    return 1
  }
}

interface_media_matches() {
  local media
  media="$(ifconfig "$NAS_EXPECTED_INTERFACE" 2>/dev/null | awk -F'media: ' '/media:/ {print $2; exit}')"
  [[ "$media" == *"$NAS_EXPECTED_MEDIA"* ]] || {
    printf 'media=%s expected contains=%s\n' "${media:-unknown}" "$NAS_EXPECTED_MEDIA"
    return 1
  }
}

mounted_at() {
  local mount_point="$1"
  mount | grep -F " on ${mount_point} " >/dev/null 2>&1
}

mount_is_nfs() {
  local mount_point="$1"
  mount | grep -F " on ${mount_point} " | grep -qi 'nfs'
}

path_writable() {
  local path="$1"
  [[ -d "$path" && -w "$path" ]]
}

NAS_LAUNCHD_LABEL="com.joelclaw.central.nas-mounts"
NAS_LAUNCHD_PLIST="/Library/LaunchDaemons/${NAS_LAUNCHD_LABEL}.plist"

launchd_plist_installed() {
  [[ -f "$NAS_LAUNCHD_PLIST" ]] || {
    printf 'missing %s\n' "$NAS_LAUNCHD_PLIST"
    printf 'live mounts will not restore after reboot\n'
    printf 'reinstall: sudo %s/install-nas-mounts.sh --bootstrap\n' "$SCRIPT_DIR"
    return 1
  }
}

launchd_service_loaded() {
  launchctl print "system/${NAS_LAUNCHD_LABEL}" >/dev/null 2>&1 || {
    printf 'launchctl print system/%s failed\n' "$NAS_LAUNCHD_LABEL"
    return 1
  }
}

# The daemon fires every 60s and its stdout log is world-readable, so log
# freshness proves the service is loaded and running without sudo.
launchd_recent_activity() {
  local log="${CENTRAL_LOG_DIR}/nas-mounts.out.log"
  [[ -f "$log" ]] || {
    printf 'missing log: %s\n' "$log"
    return 1
  }
  local age
  age=$(( $(date +%s) - $(stat -f %m "$log") ))
  [[ "$age" -le 180 ]] || {
    printf 'log stale: %s age=%ss (daemon should fire every 60s)\n' "$log" "$age"
    return 1
  }
}

path_details() {
  local path="$1"
  printf 'path_details=%s\n' "$path"
  id || true
  ls -ldn "$path" 2>&1 || true
  if have stat; then
    stat -f 'mode=%Sp uid=%u gid=%g flags=%Sf path=%N' "$path" 2>/dev/null || true
  fi
  mount | grep -F " ${path%%/s3} " 2>/dev/null || true
}

write_probe_one() {
  local label="$1"
  local data_path="$2"
  local probe_dir="${data_path}/.joelclaw-nas-proof"
  [[ -d "$data_path" ]] || {
    printf 'missing data path: %s\n' "$data_path"
    return 1
  }
  if ! mkdir -p "$probe_dir"; then
    printf 'failed_to_create_probe_dir=%s\n' "$probe_dir"
    path_details "$data_path"
    return 1
  fi
  local probe_file="${probe_dir}/${label}-$(hostname)-$(date -u +%Y%m%dT%H%M%SZ)-$$.bin"

  python3 - "$probe_file" "$BENCHMARK_MIB" <<'PY'
import os
import sys
import time

path = sys.argv[1]
mib = int(sys.argv[2])
chunk = b"0" * (1024 * 1024)
started = time.monotonic()
with open(path, "wb") as f:
    for _ in range(mib):
        f.write(chunk)
    f.flush()
    os.fsync(f.fileno())
write_elapsed = time.monotonic() - started

started = time.monotonic()
with open(path, "rb") as f:
    while f.read(1024 * 1024):
        pass
read_elapsed = time.monotonic() - started

os.remove(path)
print(f"path={path}")
print(f"size_mib={mib}")
print(f"write_seconds={write_elapsed:.3f}")
print(f"write_mib_per_sec={mib / write_elapsed:.2f}")
print(f"read_seconds={read_elapsed:.3f}")
print(f"read_mib_per_sec={mib / read_elapsed:.2f}")
PY
}

require_command route
require_command ifconfig
require_command mount
require_command nc

printf 'NAS verification\n'
printf 'host=%s user=%s nas_host=%s nas_ip=%s expected_interface=%s expected_media=%s expected_mtu=%s\n' \
  "$(hostname)" "$(id -un)" "$NAS_HOST" "$NAS_IP" "$NAS_EXPECTED_INTERFACE" "$NAS_EXPECTED_MEDIA" "$NAS_EXPECTED_MTU"
printf 'nvme_export=%s nvme_mount=%s\n' "$CENTRAL_NAS_NVME_EXPORT" "$CENTRAL_NAS_NVME_MOUNT"
printf 'hdd_export=%s hdd_mount=%s\n' "$CENTRAL_NAS_HDD_EXPORT" "$CENTRAL_NAS_HDD_MOUNT"
printf '\n'

probe 'nfs port reachable' nc_ok
probe 'route uses expected 10GbE interface' route_uses_expected_interface
probe 'interface media is 10GbE' interface_media_matches
warn_probe 'route MTU matches ADR-0088 target' route_mtu_matches
probe 'nas-nvme mounted' mounted_at "$CENTRAL_NAS_NVME_MOUNT"
probe 'nas-nvme mount is nfs' mount_is_nfs "$CENTRAL_NAS_NVME_MOUNT"
probe 'nas-hdd mounted' mounted_at "$CENTRAL_NAS_HDD_MOUNT"
probe 'nas-hdd mount is nfs' mount_is_nfs "$CENTRAL_NAS_HDD_MOUNT"
probe 'nas-mounts LaunchDaemon plist installed' launchd_plist_installed
warn_probe 'nas-mounts LaunchDaemon recently active (log freshness)' launchd_recent_activity
if [[ "$(id -u)" == "0" ]]; then
  probe 'nas-mounts LaunchDaemon loaded (system domain)' launchd_service_loaded
fi

if [[ "$WRITE_PROBE" == "1" ]]; then
  require_command python3
  printf '\nWrite/latency probes (%s MiB each):\n' "$BENCHMARK_MIB"
  printf 'hot_data_path=%s\n' "$CENTRAL_MINIO_HOT_DATA"
  printf 'cold_data_path=%s\n' "$CENTRAL_MINIO_COLD_DATA"
  probe 'nas-nvme hot object path writable/benchmarked' write_probe_one nas-nvme-hot "$CENTRAL_MINIO_HOT_DATA"
  probe 'nas-hdd cold object path writable/benchmarked' write_probe_one nas-hdd-cold "$CENTRAL_MINIO_COLD_DATA"
else
  warn_probe 'nas-nvme hot object path writable' path_writable "$CENTRAL_MINIO_HOT_DATA"
  warn_probe 'nas-hdd cold object path writable' path_writable "$CENTRAL_MINIO_COLD_DATA"
fi

exit "$status"
