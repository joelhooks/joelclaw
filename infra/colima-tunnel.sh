#!/bin/bash
# Deprecated launchd compatibility wrapper for the old Colima autossh tunnel.
# Colima/Lima already owns the docker-published host ports for joelclaw-controlplane-1.
# Running a second autossh daemon on the same ports can kill Lima's own ssh listeners
# and destabilize the Colima host path.

set -euo pipefail

export HOME="${HOME:-/Users/joel}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin"

LOG_TAG="colima-tunnel"

log() {
  logger -t "$LOG_TAG" "$1"
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1"
}

log "com.joel.colima-tunnel is deprecated: Colima/Lima hostagent already owns docker-published host ports for joelclaw-controlplane-1; exiting cleanly to avoid duplicate port-forward ownership"
exit 0
