#!/bin/bash
# Pure fixtures: never load, stop, or inspect a real launchd job.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/infra/lib/launchd-wait-removed.sh"
tmp="$(mktemp -d)"
trap 'rm -f "$tmp/count"; rmdir "$tmp"' EXIT

run_case() (
  local name="$1" delay="$2" code="$3" message="$4" expected="$5" checks="$6" rc
  printf '0' > "$tmp/count"
  # command substitution runs in a subshell, so count invocations in a fixture.
  launchctl() {
    [[ "$1" == print && "$2" == system/test ]] || return 64
    local n
    n="$(<"$tmp/count")"
    n=$((n+1))
    printf '%s' "$n" > "$tmp/count"
    if ((n <= delay)); then
      echo 'service state: SIGTERMed'
      return 0
    fi
    printf '%s\n' "$message" >&2
    return "$code"
  }
  sleep() { [[ "$1" == 0.1 ]]; }
  if launchd_wait_removed system/test >/dev/null 2>&1; then rc=0; else rc=$?; fi
  [[ "$rc" -eq "$expected" && "$(<"$tmp/count")" -eq "$checks" ]] || {
    echo "FAIL: $name (exit=$rc, checks=$(<"$tmp/count"))" >&2; exit 1;
  }
  echo "PASS: $name"
)
run_case 'already removed' 0 113 'Could not find service "test" in domain for system' 0 1
run_case 'asynchronous teardown' 3 113 'Could not find service "test" in domain for system' 0 4
run_case 'permission denied fails closed' 0 1 'Operation not permitted' 1 1
run_case 'wrong error wording fails closed' 0 113 'Unknown launchctl failure' 1 1
run_case 'wrong exit code fails closed' 0 1 'Could not find service "test" in domain for system' 1 1
run_case 'stuck teardown is bounded' 999 113 'Could not find service' 1 150

python3 - "$root/infra/launchd/com.joel.agent-secrets.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    config = plistlib.load(f)
assert config['ProcessType'] == 'Interactive', 'credential RPCs must not be background-throttled'
print('PASS: credential daemon uses Interactive scheduling')
PY
bash -n "$root/infra/install-agent-secrets-service-account.sh"
echo 'PASS: installer shell syntax'
