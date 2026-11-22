#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  -h|--help)
    printf '%s\n' 'Usage: bash k8s/render-nas-pv.sh {nas-hdd|nas-nvme|minio}' \
      'Set K8S_NAS_HOST and the matching K8S_NAS_{HDD,NVME,MINIO}_EXPORT.' \
      'Prints YAML; does not contact a cluster.'
    exit 0 ;;
  nas-hdd) export_var=K8S_NAS_HDD_EXPORT ;;
  nas-nvme) export_var=K8S_NAS_NVME_EXPORT ;;
  minio) export_var=K8S_NAS_MINIO_EXPORT ;;
  *) printf '%s\n' 'Choose nas-hdd, nas-nvme or minio (see --help).' >&2; exit 2 ;;
esac

if [[ ! ${K8S_NAS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]; then
  printf '%s\n' 'Set K8S_NAS_HOST to the NAS hostname or IPv4 address.' >&2
  exit 2
fi
if [[ ! ${!export_var:-} =~ ^/[a-zA-Z0-9._/-]+$ ]]; then
  printf '%s must be an absolute NFS export path.\n' "$export_var" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
envsubst "\$K8S_NAS_HOST \$$export_var" < "$script_dir/$1-pv.yaml"
