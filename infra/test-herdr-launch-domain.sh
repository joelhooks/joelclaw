#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_PLIST="$ROOT/infra/launchd/com.joelclaw.herdr-server.plist"
SYSTEM_PLIST="$ROOT/infra/launchd/com.joelclaw.herdr-system-server.plist"
INSTALLER="$ROOT/infra/install-critical-launchdaemons.sh"
CUTOVER="$ROOT/infra/install-herdr-default-launchagent.sh"
WRAPPER="$ROOT/infra/herdr-server-daemon.sh"

bash -n "$INSTALLER" "$CUTOVER" "$WRAPPER"
/usr/bin/plutil -lint "$DEFAULT_PLIST" "$SYSTEM_PLIST" >/dev/null

python3 - "$DEFAULT_PLIST" "$SYSTEM_PLIST" "$INSTALLER" "$CUTOVER" <<'PY'
from pathlib import Path
import plistlib
import re
import sys

default_path, system_path, installer_path, cutover_path = map(Path, sys.argv[1:])
with default_path.open("rb") as f:
    default = plistlib.load(f)
with system_path.open("rb") as f:
    system = plistlib.load(f)
installer = installer_path.read_text()
cutover = cutover_path.read_text()

assert default["Label"] == "com.joelclaw.herdr-server"
assert "UserName" not in default
assert "GroupName" not in default
assert "HERDR_SESSION" not in default.get("EnvironmentVariables", {})

assert system["Label"] == "com.joelclaw.herdr-system-server"
assert system["UserName"] == "joel"
assert system["EnvironmentVariables"]["HERDR_SESSION"] == "system"

headless = re.search(r"HEADLESS_RUNTIME_LABELS=\((.*?)\)\nINTERACTIVE", installer, re.S)
interactive = re.search(r"INTERACTIVE_LAUNCH_AGENT_LABELS=\((.*?)\)\nK8S", installer, re.S)
assert headless and "com.joelclaw.herdr-server" not in headless.group(1)
assert headless and "com.joelclaw.herdr-system-server" in headless.group(1)
assert interactive and "com.joelclaw.herdr-server" in interactive.group(1)
assert "install-herdr-default-launchagent.sh" in installer

# Keep the dangerous runtime invariants visible to this cheap contract test.
assert 'process_descends_from "$old_owner"' in cutover
assert 'refusing self-cutover from a default Herdr pane' in cutover
assert 'trap on_exit EXIT' in cutover
assert 'rollback_cutover || status=1' in cutover
assert 'launchctl enable "$GUI_TARGET"' in cutover
assert 'if ! launchctl print "gui/${TARGET_UID}"' in cutover
assert 'Installed $USER_PLIST for the next GUI login.' in cutover
assert 'run_in_gui_domain "$HERDR_BIN" status --json' in cutover
assert 'wait_for_socket_owner "$SYSTEM_TARGET"' in cutover
PY

"$CUTOVER" --help >/dev/null
printf 'herdr launch-domain contract: ok\n'
