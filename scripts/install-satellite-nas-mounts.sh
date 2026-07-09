#!/usr/bin/env bash
set -euo pipefail

# Install durable NAS mounts on a thin satellite Mac such as Blaine.
# Run on the satellite with sudo from a joelclaw checkout:
#   sudo ./scripts/install-satellite-nas-mounts.sh --bootstrap

ACTION="${1:---no-bootstrap}"
case "$ACTION" in
  --bootstrap|--no-bootstrap) ;;
  *) echo "usage: sudo $0 [--bootstrap|--no-bootstrap]" >&2; exit 2 ;;
esac

require_root() {
  [[ "$(id -u)" == "0" ]] || { echo "error: run with sudo: sudo $0 [--bootstrap]" >&2; exit 1; }
}

have() { command -v "$1" >/dev/null 2>&1; }
require_command() { have "$1" || { echo "error: missing command: $1" >&2; exit 1; }; }
log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'warn: %s\n' "$*" >&2; }

require_root
require_command install
require_command launchctl
require_command plutil
require_command networksetup
require_command ifconfig
require_command route
require_command nc
require_command mount

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

LABEL="${NAS_MOUNT_LABEL:-com.joelclaw.satellite.nas-mounts}"
SHARED_ROOT="${SERVICE_ROOT:-/Users/Shared/joelclaw}"
SHARED_REPO_DIR="${CENTRAL_REPO_ROOT:-${SHARED_ROOT}/src/joelclaw}"
CENTRAL_DIR="${SHARED_REPO_DIR}/infra/central"
ENV_FILE="${ENV_FILE:-${CENTRAL_DIR}/.env}"
LOG_DIR="${CENTRAL_LOG_DIR:-${SHARED_ROOT}/logs/central}"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"

NAS_HOST="${NAS_HOST:-192.168.1.163}"
NAS_IP="${NAS_IP:-192.168.1.163}"
NAS_EXPECTED_INTERFACE="${NAS_EXPECTED_INTERFACE:-en9}"
NAS_EXPECTED_MEDIA="${NAS_EXPECTED_MEDIA:-10Gbase-T}"
NAS_EXPECTED_MTU="${NAS_EXPECTED_MTU:-8192}"
NAS_NFS_OPTIONS="${NAS_NFS_OPTIONS:-rw,resvport,nfsvers=3,tcp,soft,intr,timeo=10,retrans=2,rsize=524288,wsize=524288,dsize=65536,readahead=128}"
CENTRAL_NAS_NVME_EXPORT="${CENTRAL_NAS_NVME_EXPORT:-${NAS_IP}:/volume2/data}"
CENTRAL_NAS_NVME_MOUNT="${CENTRAL_NAS_NVME_MOUNT:-/Volumes/nas-nvme}"
CENTRAL_NAS_HDD_EXPORT="${CENTRAL_NAS_HDD_EXPORT:-${NAS_IP}:/volume1/joelclaw}"
CENTRAL_NAS_HDD_MOUNT="${CENTRAL_NAS_HDD_MOUNT:-/Volumes/three-body}"
CENTRAL_MINIO_HOT_DATA="${CENTRAL_MINIO_HOT_DATA:-${CENTRAL_NAS_NVME_MOUNT}/s3}"
CENTRAL_MINIO_COLD_DATA="${CENTRAL_MINIO_COLD_DATA:-${CENTRAL_NAS_HDD_MOUNT}/s3}"
SERVICE_USER="${SERVICE_USER:-joel}"
SERVICE_GROUP="${SERVICE_GROUP:-staff}"

route_field() {
  local field="$1"
  route -n get "$NAS_IP" 2>/dev/null | awk -v field="$field" '$1 == field":" {print $2; exit}'
}

hardware_port_for_device() {
  local device="$1"
  networksetup -listallhardwareports | awk -v dev="$device" '
    /^Hardware Port:/ {port=substr($0, index($0, ":") + 2)}
    /^Device:/ {if ($2 == dev) {print port; exit}}
  '
}

nc_ok() {
  nc -z -G 3 "$NAS_IP" 2049 >/dev/null 2>&1 || nc -z -w 3 "$NAS_IP" 2049 >/dev/null 2>&1
}

assert_lan_route() {
  local iface media
  iface="$(route_field interface || true)"
  [[ "$iface" == "$NAS_EXPECTED_INTERFACE" ]] || fail "NAS route uses ${iface:-unknown}, expected ${NAS_EXPECTED_INTERFACE}"
  media="$(ifconfig "$NAS_EXPECTED_INTERFACE" 2>/dev/null | awk -F'media: ' '/media:/ {print $2; exit}' || true)"
  [[ "$media" == *"$NAS_EXPECTED_MEDIA"* ]] || fail "${NAS_EXPECTED_INTERFACE} media is ${media:-unknown}, expected ${NAS_EXPECTED_MEDIA}"
  nc_ok || fail "NFS port 2049 is not reachable at ${NAS_IP} over LAN"
}

set_and_prove_mtu() {
  [[ -z "$NAS_EXPECTED_MTU" || "$NAS_EXPECTED_MTU" == "0" ]] && return 0
  local current port payload
  current="$(ifconfig "$NAS_EXPECTED_INTERFACE" 2>/dev/null | awk '/ mtu / {for (i=1; i<=NF; i++) if ($i == "mtu") print $(i+1); exit}')"
  if [[ "$current" != "$NAS_EXPECTED_MTU" ]]; then
    port="$(hardware_port_for_device "$NAS_EXPECTED_INTERFACE")"
    [[ -n "$port" ]] || fail "could not find networksetup hardware port for ${NAS_EXPECTED_INTERFACE}"
    log "setting MTU ${NAS_EXPECTED_MTU} on ${port} (${NAS_EXPECTED_INTERFACE}); current=${current:-unknown}"
    networksetup -setMTU "$port" "$NAS_EXPECTED_MTU"
    sleep 2
  fi

  if [[ "$NAS_EXPECTED_MTU" -gt 1500 ]]; then
    payload=$((NAS_EXPECTED_MTU - 28))
    if ping -D -c 3 -s "$payload" "$NAS_IP" >/dev/null 2>&1; then
      log "proved MTU ${NAS_EXPECTED_MTU} to ${NAS_IP} with ping payload=${payload}"
    else
      port="$(hardware_port_for_device "$NAS_EXPECTED_INTERFACE")"
      [[ -n "$port" ]] && networksetup -setMTU "$port" 1500 || true
      fail "MTU ${NAS_EXPECTED_MTU} was not proved to ${NAS_IP}; reset ${NAS_EXPECTED_INTERFACE} to 1500 and stopped before mounting"
    fi
  fi
}

write_env() {
  mkdir -p "$CENTRAL_DIR" "$LOG_DIR"
  cat > "$ENV_FILE" <<EOF
SERVICE_USER=${SERVICE_USER}
SERVICE_GROUP=${SERVICE_GROUP}
SERVICE_ROOT=${SHARED_ROOT}
CENTRAL_REPO_ROOT=${SHARED_REPO_DIR}
CENTRAL_LOG_DIR=${LOG_DIR}

NAS_HOST=${NAS_HOST}
NAS_IP=${NAS_IP}
NAS_EXPECTED_INTERFACE=${NAS_EXPECTED_INTERFACE}
NAS_EXPECTED_MEDIA=${NAS_EXPECTED_MEDIA}
NAS_EXPECTED_MTU=${NAS_EXPECTED_MTU}
NAS_NFS_OPTIONS=${NAS_NFS_OPTIONS}
CENTRAL_NAS_NVME_EXPORT=${CENTRAL_NAS_NVME_EXPORT}
CENTRAL_NAS_NVME_MOUNT=${CENTRAL_NAS_NVME_MOUNT}
CENTRAL_NAS_HDD_EXPORT=${CENTRAL_NAS_HDD_EXPORT}
CENTRAL_NAS_HDD_MOUNT=${CENTRAL_NAS_HDD_MOUNT}
CENTRAL_MINIO_HOT_DATA=${CENTRAL_MINIO_HOT_DATA}
CENTRAL_MINIO_COLD_DATA=${CENTRAL_MINIO_COLD_DATA}
EOF
  chmod 644 "$ENV_FILE"
  log "wrote ${ENV_FILE}"
}

sync_mount_scripts() {
  mkdir -p "${CENTRAL_DIR}/scripts"
  install -m 755 "${REPO_DIR}/infra/central/scripts/common.sh" "${CENTRAL_DIR}/scripts/common.sh"
  install -m 755 "${REPO_DIR}/infra/central/scripts/mount-nas.sh" "${CENTRAL_DIR}/scripts/mount-nas.sh"
  install -m 755 "${REPO_DIR}/infra/central/scripts/verify-nas.sh" "${CENTRAL_DIR}/scripts/verify-nas.sh"
  chown -R root:wheel "$SHARED_ROOT/src" 2>/dev/null || true
  log "synced NAS mount scripts into ${CENTRAL_DIR}/scripts"
}

write_plist() {
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>WorkingDirectory</key>
    <string>${SHARED_REPO_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>ENV_FILE</key>
        <string>${ENV_FILE}</string>
    </dict>

    <key>ProgramArguments</key>
    <array>
        <string>${CENTRAL_DIR}/scripts/mount-nas.sh</string>
        <string>mount</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>60</integer>

    <key>KeepAlive</key>
    <false/>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/nas-mounts.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/nas-mounts.err.log</string>
</dict>
</plist>
EOF
  chmod 644 "$PLIST"
  chown root:wheel "$PLIST"
  plutil -lint "$PLIST" >/dev/null
  log "wrote ${PLIST}"
}

prepare_mount_points() {
  mkdir -p "$CENTRAL_NAS_NVME_MOUNT" "$CENTRAL_NAS_HDD_MOUNT" "$LOG_DIR"
  chown root:wheel "$CENTRAL_NAS_NVME_MOUNT" "$CENTRAL_NAS_HDD_MOUNT"
  chmod 755 "$CENTRAL_NAS_NVME_MOUNT" "$CENTRAL_NAS_HDD_MOUNT"
  log "prepared mount points: ${CENTRAL_NAS_NVME_MOUNT}, ${CENTRAL_NAS_HDD_MOUNT}"
}

bootout_if_loaded() {
  launchctl print "system/${LABEL}" >/dev/null 2>&1 || return 0
  launchctl bootout "system/${LABEL}" >/dev/null 2>&1 || launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
}

assert_lan_route
set_and_prove_mtu
sync_mount_scripts
write_env
write_plist
prepare_mount_points

if [[ "$ACTION" == "--bootstrap" ]]; then
  launchctl enable "system/${LABEL}" || true
  bootout_if_loaded
  launchctl bootstrap system "$PLIST"
  launchctl kickstart -k "system/${LABEL}" >/dev/null 2>&1 || true
  launchctl print "system/${LABEL}" >/dev/null
  log "bootstrapped system/${LABEL}"
  "$CENTRAL_DIR/scripts/mount-nas.sh" status
else
  bootout_if_loaded
  launchctl disable "system/${LABEL}" || true
  log "installed and disabled system/${LABEL}; rerun with --bootstrap to mount at boot"
fi
