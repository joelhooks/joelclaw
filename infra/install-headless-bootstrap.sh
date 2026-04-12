#!/bin/bash
set -euo pipefail

echo "ADR-0239 headless user-domain bridge is superseded. Installing boot-safe LaunchDaemons instead."
exec "$(cd "$(dirname "$0")" && pwd)/install-critical-launchdaemons.sh" "$@"
