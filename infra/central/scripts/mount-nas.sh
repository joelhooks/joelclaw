#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
load_env_if_present

ACTION="${1:-mount}"

require_root() {
  [[ "$(id -u)" == "0" ]] || fail "run with sudo: sudo $0 [mount|status|unmount]"
}

nc_ok() {
  local host="$1"
  local port="$2"
  nc -z -G 3 "$host" "$port" >/dev/null 2>&1 || nc -z -w 3 "$host" "$port" >/dev/null 2>&1
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

mounted_at() {
  local mount_point="$1"
  mount | grep -F " on ${mount_point} " >/dev/null 2>&1
}

wait_for_network() {
  local attempts="${NAS_MOUNT_WAIT_ATTEMPTS:-60}"
  local sleep_seconds="${NAS_MOUNT_WAIT_SLEEP:-2}"

  for ((i = 1; i <= attempts; i++)); do
    local iface
    iface="$(route_field interface || true)"
    if [[ "$iface" == "$NAS_EXPECTED_INTERFACE" ]] && nc_ok "$NAS_IP" 2049; then
      return 0
    fi
    log "waiting for nas route/nfs (${i}/${attempts}) interface=${iface:-unknown} host=${NAS_HOST} ip=${NAS_IP}"
    sleep "$sleep_seconds"
  done

  fail "NAS route/NFS did not become ready for ${NAS_IP} (${NAS_HOST}) on ${NAS_EXPECTED_INTERFACE}"
}

assert_10gbe_route() {
  local iface mtu media
  iface="$(route_field interface || true)"
  mtu="$(route_mtu || true)"
  media="$(ifconfig "$NAS_EXPECTED_INTERFACE" 2>/dev/null | awk -F'media: ' '/media:/ {print $2; exit}' || true)"

  [[ "$iface" == "$NAS_EXPECTED_INTERFACE" ]] || fail "NAS route uses ${iface:-unknown}, expected ${NAS_EXPECTED_INTERFACE}"
  [[ "$media" == *"$NAS_EXPECTED_MEDIA"* ]] || fail "${NAS_EXPECTED_INTERFACE} media is ${media:-unknown}, expected ${NAS_EXPECTED_MEDIA}"

  if [[ -n "$NAS_EXPECTED_MTU" && "$NAS_EXPECTED_MTU" != "0" && -n "$mtu" && "$mtu" != "$NAS_EXPECTED_MTU" ]]; then
    warn "NAS route MTU is ${mtu}, expected ${NAS_EXPECTED_MTU}; mount can proceed but Gate 5 must record/fix this"
  fi
}

mount_one() {
  local label="$1"
  local export_path="$2"
  local mount_point="$3"

  mkdir -p "$mount_point"
  if mounted_at "$mount_point"; then
    return 0
  fi

  log "mounting ${label}: ${export_path} -> ${mount_point} options=${NAS_NFS_OPTIONS}"
  mount -t nfs -o "$NAS_NFS_OPTIONS" "$export_path" "$mount_point"
  mounted_at "$mount_point" || fail "${label} mount command returned but ${mount_point} is not mounted"
  log "mounted ${label} at ${mount_point}"
}

unmount_one() {
  local label="$1"
  local mount_point="$2"
  if mounted_at "$mount_point"; then
    log "unmounting ${label}: ${mount_point}"
    if umount "$mount_point"; then
      return 0
    fi
    warn "normal umount failed for ${label}; trying forced unmount"
    if umount -f "$mount_point"; then
      return 0
    fi
    if have diskutil; then
      warn "forced umount failed for ${label}; trying diskutil unmount force"
      diskutil unmount force "$mount_point"
    else
      fail "failed to unmount ${label}: ${mount_point}"
    fi
  else
    log "${label} not mounted: ${mount_point}"
  fi
}

status_one() {
  local label="$1"
  local mount_point="$2"
  if mounted_at "$mount_point"; then
    printf 'ok   %s mounted at %s\n' "$label" "$mount_point"
    mount | grep -F " on ${mount_point} "
  else
    printf 'fail %s not mounted at %s\n' "$label" "$mount_point"
    return 1
  fi
}

case "$ACTION" in
  mount)
    require_root
    require_command route
    require_command ifconfig
    require_command nc
    require_command mount
    require_command umount
    wait_for_network
    assert_10gbe_route
    mount_one nas-nvme "$CENTRAL_NAS_NVME_EXPORT" "$CENTRAL_NAS_NVME_MOUNT"
    mount_one nas-hdd "$CENTRAL_NAS_HDD_EXPORT" "$CENTRAL_NAS_HDD_MOUNT"
    mount_one badass-media "$CENTRAL_NAS_MEDIA_EXPORT" "$CENTRAL_NAS_MEDIA_MOUNT"
    log "NAS mounts ready: nas-nvme, nas-hdd, badass-media"
    ;;
  status)
    require_command mount
    status=0
    status_one nas-nvme "$CENTRAL_NAS_NVME_MOUNT" || status=1
    status_one nas-hdd "$CENTRAL_NAS_HDD_MOUNT" || status=1
    status_one badass-media "$CENTRAL_NAS_MEDIA_MOUNT" || status=1
    exit "$status"
    ;;
  unmount)
    require_root
    require_command umount
    unmount_one badass-media "$CENTRAL_NAS_MEDIA_MOUNT"
    unmount_one nas-hdd "$CENTRAL_NAS_HDD_MOUNT"
    unmount_one nas-nvme "$CENTRAL_NAS_NVME_MOUNT"
    ;;
  *)
    fail "usage: $0 [mount|status|unmount]"
    ;;
esac
