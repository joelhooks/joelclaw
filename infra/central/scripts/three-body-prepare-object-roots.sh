#!/bin/sh
set -eu

HOT_PATH="${HOT_PATH:-/volume2/data/s3}"
COLD_PATH="${COLD_PATH:-/volume1/joelclaw/s3}"
FLAGG_UID="${FLAGG_UID:-502}"
FLAGG_GID="${FLAGG_GID:-20}"
# Proof mode is intentionally broad to bypass NAS/NFS id-map weirdness during Gate 5 proof.
# Harden after MinIO data-plane proof if NAS id mapping behaves.
PROOF_MODE="${PROOF_MODE:-2777}"
FINAL_MODE="${FINAL_MODE:-2770}"
USE_FINAL_MODE="${USE_FINAL_MODE:-0}"

if [ "$(id -u)" != "0" ]; then
  echo "error: run as root, e.g. sudo sh $0" >&2
  exit 1
fi

mode="$PROOF_MODE"
if [ "$USE_FINAL_MODE" = "1" ]; then
  mode="$FINAL_MODE"
fi

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
