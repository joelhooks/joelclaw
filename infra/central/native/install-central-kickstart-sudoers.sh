#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE="${SCRIPT_DIR}/sudoers-joelclaw-central"
TARGET="/etc/sudoers.d/joelclaw-central"

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run once with sudo: sudo %s\n' "$0" >&2
  exit 2
fi

# visudo -c on the candidate before it can brick sudo.
install -o root -g wheel -m 0440 "${SOURCE}" "${TARGET}.tmp"
if ! visudo -c -f "${TARGET}.tmp"; then
  rm -f "${TARGET}.tmp"
  printf 'sudoers candidate failed visudo check; nothing installed\n' >&2
  exit 1
fi
mv "${TARGET}.tmp" "${TARGET}"

printf 'Installed %s\n' "${TARGET}"
sudo -l -U joel | grep -A 10 NOPASSWD || true
