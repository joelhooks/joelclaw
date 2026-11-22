#!/bin/sh
set -eu

if [ "${1:-}" = --help ]; then
  printf '%s\n' 'Set HOT_PATH, COLD_PATH, NAS_SERVICE_UID, NAS_SERVICE_GID, NAS_SERVICE_GROUP and NAS_SERVICE_USER.'
  exit 0
fi
HOT_PATH="${HOT_PATH:?set the private hot object path}"
COLD_PATH="${COLD_PATH:?set the private cold object path}"
NAS_SERVICE_UID="${NAS_SERVICE_UID:-${FLAGG_UID:?set NAS_SERVICE_UID}}"
NAS_SERVICE_GID="${NAS_SERVICE_GID:-${FLAGG_GID:?set NAS_SERVICE_GID}}"
NAS_SERVICE_GROUP="${NAS_SERVICE_GROUP:-${FLAGG_GROUP:?set NAS_SERVICE_GROUP}}"
NAS_SERVICE_USER="${NAS_SERVICE_USER:-${FLAGG_USER:?set NAS_SERVICE_USER}}"
# Proof mode is intentionally broad to bypass NAS/NFS id-map weirdness during Gate 5 proof.
# Harden after MinIO data-plane proof if NAS id mapping behaves.
PROOF_MODE="${PROOF_MODE:-2777}"
FINAL_MODE="${FINAL_MODE:-2770}"
USE_FINAL_MODE="${USE_FINAL_MODE:-0}"

if [ "$(id -u)" != "0" ]; then
  echo "error: run as root, e.g. sudo sh $0" >&2
  exit 1
fi

ensure_group() {
  if getent group "$NAS_SERVICE_GID" >/dev/null 2>&1; then
    echo "group gid ${NAS_SERVICE_GID} exists: $(getent group "$NAS_SERVICE_GID")"
  elif getent group "$NAS_SERVICE_GROUP" >/dev/null 2>&1; then
    echo "group ${NAS_SERVICE_GROUP} exists with different gid: $(getent group "$NAS_SERVICE_GROUP")"
  else
    echo "creating group ${NAS_SERVICE_GROUP} gid=${NAS_SERVICE_GID}"
    /usr/builtin/sbin/groupadd -g "$NAS_SERVICE_GID" "$NAS_SERVICE_GROUP"
  fi
}

ensure_user() {
  if getent passwd "$NAS_SERVICE_UID" >/dev/null 2>&1; then
    echo "user uid ${NAS_SERVICE_UID} exists: $(getent passwd "$NAS_SERVICE_UID")"
  elif getent passwd "$NAS_SERVICE_USER" >/dev/null 2>&1; then
    echo "user ${NAS_SERVICE_USER} exists with different uid: $(getent passwd "$NAS_SERVICE_USER")"
  else
    echo "creating user ${NAS_SERVICE_USER} uid=${NAS_SERVICE_UID} gid=${NAS_SERVICE_GID}"
    /usr/builtin/sbin/useradd \
      -u "$NAS_SERVICE_UID" \
      -g "$NAS_SERVICE_GID" \
      -G users \
      -M \
      -N \
      -s /bin/false \
      -c "Central joelclaw NFS identity" \
      "$NAS_SERVICE_USER"
  fi
}

mode="$PROOF_MODE"
if [ "$USE_FINAL_MODE" = "1" ]; then
  mode="$FINAL_MODE"
fi

ensure_group
ensure_user

for path in "$HOT_PATH" "$COLD_PATH"; do
  echo "preparing $path for Central service uid:gid ${NAS_SERVICE_UID}:${NAS_SERVICE_GID} mode=${mode}"
  mkdir -p "$path"
  rm -rf "$path/.joelclaw-nas-proof"
  chown -R "${NAS_SERVICE_UID}:${NAS_SERVICE_GID}" "$path"
  chmod -R u+rwX,g+rwX "$path"
  chmod "$mode" "$path"
  ls -ldn "$path"
done

echo "done"
