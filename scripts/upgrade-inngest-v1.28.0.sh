#!/bin/bash

set -euo pipefail

VERSION="1.28.0"
RELEASE_COMMIT="195554d82"
ROOT="/Users/Shared/joelclaw"
LABEL="com.joelclaw.central.inngest"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
WRAPPER="${ROOT}/bin/central-inngest"
ARCHIVE="inngest_${VERSION}_darwin_arm64.tar.gz"
ARCHIVE_SHA256="f71302a6921bf2f8b93aba89340911d0112d6815501b0f1482011747d74ab0cc"
DOWNLOAD_URL="https://github.com/inngest/inngest/releases/download/v${VERSION}/${ARCHIVE}"
TMP="$(mktemp -d "/tmp/inngest-${VERSION}.XXXXXX")"
STAGED="${TMP}/staged"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${ROOT}/backups/inngest/${STAMP}"

cleanup() {
  rm -f \
    "${TMP}/${ARCHIVE}" \
    "${TMP}/inngest" \
    "${STAGED}/central-inngest" \
    "${STAGED}/${LABEL}.plist"
  rmdir "${STAGED}" "${TMP}" 2>/dev/null || true
}
trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo bash scripts/upgrade-inngest-v1.28.0.sh" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Expected Darwin arm64; found $(uname -s) $(uname -m)" >&2
  exit 1
fi

for path in "${WRAPPER}" "${PLIST}"; do
  if [[ ! -f "${path}" ]]; then
    echo "Required file does not exist: ${path}" >&2
    exit 1
  fi
done

mkdir -p "${STAGED}"

echo "Downloading Inngest v${VERSION}..."
curl -fsSL "${DOWNLOAD_URL}" -o "${TMP}/${ARCHIVE}"

printf '%s  %s\n' "${ARCHIVE_SHA256}" "${TMP}/${ARCHIVE}" | shasum -a 256 -c -

tar -xzf "${TMP}/${ARCHIVE}" -C "${TMP}"
file "${TMP}/inngest"

INSTALLED_VERSION="$("${TMP}/inngest" version)"
if [[ ! "${INSTALLED_VERSION}" =~ ^1[.]28[.]0-${RELEASE_COMMIT}[0-9a-f]*$ ]]; then
  echo "Unexpected Inngest version: ${INSTALLED_VERSION}" >&2
  exit 1
fi
echo "Verified ${INSTALLED_VERSION}"

# Refuse to rewrite an unexpected service definition.
if [[ "$(grep -c '/opt/inngest/1\.27\.0' "${WRAPPER}")" -ne 2 ]]; then
  echo "Expected exactly two v1.27.0 paths in ${WRAPPER}" >&2
  exit 1
fi
if [[ "$(grep -c '/opt/inngest/1\.27\.0' "${PLIST}")" -ne 1 ]]; then
  echo "Expected exactly one v1.27.0 path in ${PLIST}" >&2
  exit 1
fi

sed 's#/opt/inngest/1\.27\.0#/opt/inngest/1.28.0#g' \
  "${WRAPPER}" > "${STAGED}/central-inngest"

sed 's#/opt/inngest/1\.27\.0#/opt/inngest/1.28.0#g' \
  "${PLIST}" > "${STAGED}/${LABEL}.plist"

grep -q '/opt/inngest/1\.28\.0' "${STAGED}/central-inngest"
grep -q '/opt/inngest/1\.28\.0' "${STAGED}/${LABEL}.plist"
if grep -q '/opt/inngest/1\.27\.0' "${STAGED}/central-inngest"; then
  echo "Staged wrapper still references v1.27.0" >&2
  exit 1
fi
if grep -q '/opt/inngest/1\.27\.0' "${STAGED}/${LABEL}.plist"; then
  echo "Staged plist still references v1.27.0" >&2
  exit 1
fi
plutil -lint "${STAGED}/${LABEL}.plist"

# Install the versioned binary before stopping the current daemon.
install -d -o joelclaw -g staff -m 0755 "${ROOT}/opt/inngest/${VERSION}"
install -o joelclaw -g staff -m 0755 \
  "${TMP}/inngest" \
  "${ROOT}/opt/inngest/${VERSION}/inngest"

# Keep timestamped copies of the exact live wrapper and plist.
install -d -o root -g wheel -m 0750 "${BACKUP_DIR}"
install -o root -g wheel -m 0755 \
  "${WRAPPER}" \
  "${BACKUP_DIR}/central-inngest"
install -o root -g wheel -m 0644 \
  "${PLIST}" \
  "${BACKUP_DIR}/${LABEL}.plist"

echo "Backed up service files to ${BACKUP_DIR}"

launchctl bootout "system/${LABEL}"

install -o joelclaw -g staff -m 0755 \
  "${STAGED}/central-inngest" \
  "${WRAPPER}"
install -o root -g wheel -m 0644 \
  "${STAGED}/${LABEL}.plist" \
  "${PLIST}"

launchctl bootstrap system "${PLIST}"
launchctl enable "system/${LABEL}"
launchctl kickstart -k "system/${LABEL}"
launchctl print "system/${LABEL}"

# Give launchd a short window to spawn the new binary, then make the ps check fatal.
for _ in $(seq 1 30); do
  if ps -axo pid,user,command | grep -q '[o]pt/inngest/1\.28\.0/inngest'; then
    break
  fi
  sleep 1
done
ps -axo pid,user,command | grep '[o]pt/inngest/1\.28\.0/inngest'

curl -fsS -X PUT http://127.0.0.1:3111/api/inngest
printf '\n'

cat <<'POST_VERIFY'
Upgrade commands finished. These post-verification steps were NOT run:

1. After at least two cron intervals, check for new missing-env-ID errors:

tail -n 5000 /Users/Shared/joelclaw/logs/inngest/launchd.err.log | grep -E 'missing env ID|56a06f24|f1455a8e|f36937bd'

2. Confirm at least one target function has a new COMPLETED run after this upgrade before applying any queue purge.
POST_VERIFY
