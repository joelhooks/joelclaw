#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/joel/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

PROFILE="${COLIMA_PROFILE:-default}"
CPU="${COLIMA_CPU:-8}"
MEMORY="${COLIMA_MEMORY:-24}"
DISK="${COLIMA_DISK:-100}"
VM_TYPE="${COLIMA_VM_TYPE:-vz}"
MOUNT_TYPE="${COLIMA_MOUNT_TYPE:-virtiofs}"
PORT_FORWARDER="${COLIMA_PORT_FORWARDER:-grpc}"

log() {
  printf '[colima-start] %s\n' "$*"
}

profile_running() {
  local raw

  raw="$(colima list --json 2>/dev/null || true)"
  python3 - "$PROFILE" "$raw" <<'PY'
import json
import sys

profile = sys.argv[1]
raw = sys.argv[2].strip()
if not raw:
    sys.exit(1)
try:
    data = json.loads(raw)
except Exception:
    sys.exit(1)
profiles = data if isinstance(data, list) else [data]
for item in profiles:
    if item.get("name") == profile and item.get("status") == "Running":
        sys.exit(0)
sys.exit(1)
PY
}

if profile_running; then
  log "profile ${PROFILE} already running"
  exit 0
fi

log "starting profile ${PROFILE} with ${CPU} CPU, ${MEMORY}GiB memory, ${DISK}GiB disk, ${PORT_FORWARDER} port forwarder"
exec colima start \
  --profile "$PROFILE" \
  --vm-type "$VM_TYPE" \
  --mount-type "$MOUNT_TYPE" \
  --cpu "$CPU" \
  --memory "$MEMORY" \
  --disk "$DISK" \
  --port-forwarder "$PORT_FORWARDER"
