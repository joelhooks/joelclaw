#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE="${SCRIPT_DIR}/sudoers-agent-secrets"
TARGET="/etc/sudoers.d/agent-secrets"

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run once as root during host bootstrap: sudo %s\n' "$0" >&2
  exit 2
fi

[ -f "$SOURCE" ] || {
  printf 'Missing sudoers source: %s\n' "$SOURCE" >&2
  exit 1
}

candidate="$(mktemp /var/tmp/agent-secrets-sudoers.XXXXXX)"
trap 'rm -f "$candidate"' EXIT HUP INT TERM
install -o root -g wheel -m 0440 "$SOURCE" "$candidate"
/usr/sbin/visudo -c -f "$candidate" >/dev/null
install -o root -g wheel -m 0440 "$candidate" "$TARGET"

printf 'Installed passwordless, exact-command agent-secrets recovery: %s\n' "$TARGET"
