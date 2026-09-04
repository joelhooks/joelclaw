#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: sudo infra/install-herdr-default-launchagent.sh [--cutover]

Installs the default operator-facing Herdr server as a GUI LaunchAgent.
Without --cutover, an existing system-domain server keeps its panes until the
next restart. With --cutover, the system-domain server is stopped after a
waiting GUI-domain replacement is loaded.

Run --cutover from an external terminal or the named system Herdr session.
The script refuses to cut over from a default Herdr pane because stopping that
server would kill the installer before it could verify or roll back.
EOF
}

CUTOVER=0
case "${1:-}" in
  "") ;;
  --cutover) CUTOVER=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  suffix=""
  [ "$CUTOVER" -eq 1 ] && suffix=" --cutover"
  echo "Run as root: sudo $0${suffix}" >&2
  exit 1
fi

TARGET_USER="${TARGET_USER:-joel}"
TARGET_GROUP="${TARGET_GROUP:-staff}"
TARGET_HOME="${TARGET_HOME:-/Users/${TARGET_USER}}"
TARGET_UID="$(id -u "$TARGET_USER")"
REPO_ROOT="${REPO_ROOT:-${TARGET_HOME}/Code/joelhooks/joelclaw}"
LABEL="com.joelclaw.herdr-server"
SOURCE_PLIST="${REPO_ROOT}/infra/launchd/${LABEL}.plist"
USER_PLIST="${TARGET_HOME}/Library/LaunchAgents/${LABEL}.plist"
SYSTEM_PLIST="/Library/LaunchDaemons/${LABEL}.plist"
SOCKET="${TARGET_HOME}/.config/herdr/herdr.sock"
HERDR_BIN="${TARGET_HOME}/.local/bin/herdr"
GUI_TARGET="gui/${TARGET_UID}/${LABEL}"
SYSTEM_TARGET="system/${LABEL}"
BACKUP_PLIST=""
ROLLBACK_ARMED=0
CUTOVER_COMMITTED=0

fail() {
  echo "herdr LaunchAgent install failed: $*" >&2
  exit 1
}

service_pid() {
  launchctl print "$1" 2>/dev/null \
    | awk '/^[[:space:]]*pid = / {print $3; exit}' \
    || true
}

socket_owner_pid() {
  /usr/sbin/lsof -t "$SOCKET" 2>/dev/null | head -1 || true
}

process_descends_from() {
  local ancestor="$1"
  local pid="$$"
  local parent
  while [ "$pid" -gt 1 ] 2>/dev/null; do
    [ "$pid" = "$ancestor" ] && return 0
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    [ -n "$parent" ] || break
    pid="$parent"
  done
  return 1
}

run_in_gui_domain() {
  launchctl asuser "$TARGET_UID" /usr/bin/sudo -u "$TARGET_USER" \
    /usr/bin/env HOME="$TARGET_HOME" USER="$TARGET_USER" \
    PATH="${TARGET_HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$@"
}

wait_for_socket_owner() {
  local target="$1"
  local attempts="${2:-40}"
  local expected_pid
  local owner_pid
  while [ "$attempts" -gt 0 ]; do
    expected_pid="$(service_pid "$target")"
    owner_pid="$(socket_owner_pid)"
    if [ -n "$expected_pid" ] && [ "$owner_pid" = "$expected_pid" ]; then
      printf '%s\n' "$expected_pid"
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 0.5
  done
  return 1
}

rollback_cutover() {
  local restored_pid=""
  echo "Restoring the system-domain Herdr server." >&2
  if [ -z "$BACKUP_PLIST" ] || [ ! -f "$BACKUP_PLIST" ]; then
    echo "Rollback failed: no system plist backup is available." >&2
    return 1
  fi

  install -o root -g wheel -m 644 "$BACKUP_PLIST" "$SYSTEM_PLIST"
  launchctl enable "$SYSTEM_TARGET" || return 1
  if ! launchctl print "$SYSTEM_TARGET" >/dev/null 2>&1; then
    launchctl bootstrap system "$SYSTEM_PLIST" || return 1
  fi

  # The restored wrapper waits while the GUI server owns the socket. Stop the
  # failed GUI job only after that fallback is loaded and ready to take over.
  launchctl bootout "$GUI_TARGET" >/dev/null 2>&1 || true
  restored_pid="$(wait_for_socket_owner "$SYSTEM_TARGET" 40 || true)"
  if [ -z "$restored_pid" ]; then
    echo "Rollback failed: the restored system job does not own $SOCKET." >&2
    return 1
  fi
  if ! run_in_gui_domain "$HERDR_BIN" status --json >/dev/null 2>&1; then
    echo "Rollback failed: the restored Herdr server does not answer." >&2
    return 1
  fi
  echo "Rollback verified: system PID $restored_pid owns $SOCKET and answers." >&2
}

on_exit() {
  local status="$?"
  trap - EXIT
  if [ "$ROLLBACK_ARMED" -eq 1 ] && [ "$CUTOVER_COMMITTED" -ne 1 ]; then
    rollback_cutover || status=1
  fi
  rm -f "$BACKUP_PLIST"
  exit "$status"
}
trap on_exit EXIT

[ -f "$SOURCE_PLIST" ] || fail "missing source plist: $SOURCE_PLIST"
[ -x "$HERDR_BIN" ] || fail "missing Herdr executable: $HERDR_BIN"
/usr/bin/plutil -lint "$SOURCE_PLIST" >/dev/null
/usr/libexec/PlistBuddy -c 'Print :Label' "$SOURCE_PLIST" 2>/dev/null \
  | grep -Fx "$LABEL" >/dev/null || fail "source plist has the wrong Label"
if /usr/libexec/PlistBuddy -c 'Print :UserName' "$SOURCE_PLIST" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c 'Print :GroupName' "$SOURCE_PLIST" >/dev/null 2>&1; then
  fail "the GUI LaunchAgent plist must not contain UserName or GroupName"
fi

install -d -o "$TARGET_USER" -g "$TARGET_GROUP" -m 755 \
  "${TARGET_HOME}/Library/LaunchAgents" "${TARGET_HOME}/.local/log"
install -o "$TARGET_USER" -g "$TARGET_GROUP" -m 644 \
  "$SOURCE_PLIST" "$USER_PLIST"

system_loaded=0
launchctl print "$SYSTEM_TARGET" >/dev/null 2>&1 && system_loaded=1
if [ -f "$SYSTEM_PLIST" ]; then
  BACKUP_PLIST="$(mktemp /var/tmp/${LABEL}.rollback.XXXXXX)"
  cp "$SYSTEM_PLIST" "$BACKUP_PLIST"
elif [ "$CUTOVER" -eq 1 ] && [ "$system_loaded" -eq 1 ]; then
  fail "the loaded system job has no plist to restore if cutover fails"
fi

if [ "$CUTOVER" -eq 1 ] && [ "$system_loaded" -eq 1 ]; then
  old_owner="$(socket_owner_pid)"
  if [ -n "$old_owner" ] && process_descends_from "$old_owner"; then
    fail "refusing self-cutover from a default Herdr pane; use an external terminal or HERDR_SESSION=system"
  fi
fi

# Installing the plist is valid before login. Immediate bootstrap and cutover
# require the logged-in Aqua domain, but headless installers must still finish.
if ! launchctl print "gui/${TARGET_UID}" >/dev/null 2>&1; then
  [ "$CUTOVER" -ne 1 ] || fail "no GUI login domain for uid ${TARGET_UID}"
  if [ "$system_loaded" -eq 1 ]; then
    launchctl disable "$SYSTEM_TARGET"
    echo "Installed $USER_PLIST for the next GUI login."
    echo "Disabled $SYSTEM_TARGET for future boots; its loaded process still owns live panes."
  else
    rm -f "$SYSTEM_PLIST"
    echo "Installed $USER_PLIST for the next GUI login."
  fi
  exit 0
fi

launchctl enable "$GUI_TARGET"
if ! launchctl print "$GUI_TARGET" >/dev/null 2>&1; then
  launchctl bootstrap "gui/${TARGET_UID}" "$USER_PLIST" \
    || fail "could not bootstrap $GUI_TARGET"
fi

if [ "$system_loaded" -eq 1 ]; then
  if [ "$CUTOVER" -ne 1 ]; then
    # Disable affects future launches, not the running process. Keep the old
    # plist as rollback material until an approved cutover.
    launchctl disable "$SYSTEM_TARGET"
    echo "Installed $USER_PLIST."
    echo "Disabled $SYSTEM_TARGET for future boots; its loaded process still owns live panes."
    echo "Run sudo $0 --cutover from outside the default Herdr session."
    exit 0
  fi

  launchctl disable "$SYSTEM_TARGET"
  ROLLBACK_ARMED=1
  launchctl bootout "$SYSTEM_TARGET"
fi

new_pid="$(wait_for_socket_owner "$GUI_TARGET" 40 || true)"
[ -n "$new_pid" ] || fail "GUI Herdr did not take ownership of $SOCKET"
manager="$(run_in_gui_domain /bin/launchctl managername 2>/dev/null || true)"
[ "$manager" = "Aqua" ] || fail "GUI audit session check returned '${manager:-empty}'"
run_in_gui_domain "$HERDR_BIN" status --json >/dev/null \
  || fail "GUI Herdr owns the socket but does not answer"

rm -f "$SYSTEM_PLIST"
CUTOVER_COMMITTED=1
ROLLBACK_ARMED=0
rm -f "$BACKUP_PLIST"
BACKUP_PLIST=""

printf 'Installed: %s\n' "$USER_PLIST"
printf 'Removed:   %s\n' "$SYSTEM_PLIST"
printf 'Domain:    gui/%s (%s)\n' "$TARGET_UID" "$manager"
printf 'PID:       %s\n' "$new_pid"
printf 'Socket:    %s\n' "$SOCKET"
