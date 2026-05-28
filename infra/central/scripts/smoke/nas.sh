#!/usr/bin/env bash
set -euo pipefail

SMOKE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SMOKE_SCRIPT_DIR}/lib.sh"

smoke_log "verifying NAS route, mounts, and write probes"
"${SMOKE_SCRIPT_DIR}/../verify-nas.sh" --write-probe --benchmark-mib "${NAS_BENCHMARK_MIB:-64}"
