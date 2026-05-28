#!/bin/sh
set -eu

HOT_PATH="${HOT_PATH:-/volume2/data/s3}"
COLD_PATH="${COLD_PATH:-/volume1/joelclaw/s3}"
FLAGG_UID="${FLAGG_UID:-502}"
FLAGG_GID="${FLAGG_GID:-20}"
FLAGG_GROUP="${FLAGG_GROUP:-staff}"
FLAGG_USER="${FLAGG_USER:-joelclaw}"
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
  if getent group "$FLAGG_GID" >/dev/null 2>&1; then
    echo "group gid ${FLAGG_GID} exists: $(getent group "$FLAGG_GID")"
  elif getent group "$FLAGG_GROUP" >/dev/null 2>&1; then
    echo "group ${FLAGG_GROUP} exists with different gid: $(getent group "$FLAGG_GROUP")"
  else
    echo "creating group ${FLAGG_GROUP} gid=${FLAGG_GID}"
    /usr/builtin/sbin/groupadd -g "$FLAGG_GID" "$FLAGG_GROUP"
  fi
}

ensure_user() {
  if getent passwd "$FLAGG_UID" >/dev/null 2>&1; then
    echo "user uid ${FLAGG_UID} exists: $(getent passwd "$FLAGG_UID")"
  elif getent passwd "$FLAGG_USER" >/dev/null 2>&1; then
    echo "user ${FLAGG_USER} exists with different uid: $(getent passwd "$FLAGG_USER")"
  else
    echo "creating user ${FLAGG_USER} uid=${FLAGG_UID} gid=${FLAGG_GID}"
    /usr/builtin/sbin/useradd \
      -u "$FLAGG_UID" \
      -g "$FLAGG_GID" \
      -G users \
      -M \
      -N \
      -s /bin/false \
      -c "Flagg joelclaw NFS identity" \
      "$FLAGG_USER"
  fi
}

mode="$PROOF_MODE"
if [ "$USE_FINAL_MODE" = "1" ]; then
  mode="$FINAL_MODE"
fi

ensure_group
ensure_user

for path in "$HOT_PATH" "$COLD_PATH"; do
  echo "preparing $path for Flagg service uid:gid ${FLAGG_UID}:${FLAGG_GID} mode=${mode}"
  mkdir -p "$path"
  rm -rf "$path/.joelclaw-flagg-nas-proof"
  chown -R "${FLAGG_UID}:${FLAGG_GID}" "$path"
  chmod -R u+rwX,g+rwX "$path"
  chmod "$mode" "$path"
  ls -ldn "$path"
done

echo "done"
