#!/bin/sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="${CRITICAL_SEARCH_REPLICATION_CONFIG:-$HOME/.config/joelclaw/critical-search-replication.env}"
[ -f "$CONFIG_FILE" ] || { echo "missing config: $CONFIG_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONFIG_FILE"
TOKEN_FILE="${CRITICAL_SEARCH_TOKEN_FILE:-$HOME/.config/joelclaw/critical-search-replica.token}"
if [ ! -f "$TOKEN_FILE" ]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  umask 077
  openssl rand -hex 32 > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
CRITICAL_SEARCH_TOKEN="$(cat "$TOKEN_FILE")"
[ "${#CRITICAL_SEARCH_TOKEN}" -ge 32 ] || { echo "critical-search token is too short" >&2; exit 1; }

stage_one() {
  name="$1"
  host="$2"
  root="$3"
  bind_addr="$4"
  container="$5"
  docker_path="${6:-}"

  echo "staging $name on $host:$root"
  ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
    "mkdir -p '$root/data' && chmod 750 '$root' '$root/data'" || return 1
  for file in Dockerfile compose.yaml server.py publish-replica.sh; do
    ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
      "cat > '$root/$file'" < "$REPO_ROOT/infra/critical-search-replica/$file" || return 1
  done
  ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
    "chmod 640 '$root/Dockerfile' '$root/compose.yaml' && chmod 750 '$root/server.py' '$root/publish-replica.sh'" || return 1
  replica_uid="$(ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" 'id -u')" || return 1
  replica_gid="$(ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" 'id -g')" || return 1
  ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
    "cat > '$root/.env' && chmod 600 '$root/.env'" <<EOF
REPLICA_NAME=$name
REPLICA_BIND_ADDR=$bind_addr
CONTAINER_NAME=$container
REPLICA_UID=$replica_uid
REPLICA_GID=$replica_gid
CRITICAL_SEARCH_TOKEN=$CRITICAL_SEARCH_TOKEN
EOF
  [ "$?" -eq 0 ] || return 1

  if [ -z "$docker_path" ]; then
    if ! docker_path="$(ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
      'for path in /usr/local/bin/docker /usr/builtin/bin/docker /usr/local/AppCentral/docker-ce/bin/docker /var/packages/ContainerManager/target/usr/bin/docker /var/packages/Docker/target/usr/bin/docker; do [ -x "$path" ] && { echo "$path"; break; }; done')"; then
      echo "$name staged; Docker probe failed" >&2
      return 1
    fi
  fi
  if [ -z "$docker_path" ]; then
    echo "$name staged; blocked: Docker/Container Manager is not installed" >&2
    return 2
  fi
  if ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" "'$docker_path' compose version" >/dev/null 2>&1; then
    compose_command="'$docker_path' compose"
  else
    compose_path="$(ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
      'for path in /usr/local/bin/docker-compose /usr/bin/docker-compose /usr/local/AppCentral/docker-ce/bin/docker-compose; do [ -x "$path" ] && { echo "$path"; break; }; done')"
    if [ -z "$compose_path" ]; then
      echo "$name staged; blocked: neither Docker Compose plugin nor docker-compose exists" >&2
      return 2
    fi
    compose_command="'$compose_path'"
  fi
  if ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" "sudo -n true" >/dev/null 2>&1; then
    ssh -o BatchMode=yes -o ConnectTimeout=12 "$host" \
      "cd '$root' && sudo $compose_command up -d --build"
    return 0
  fi
  echo "$name staged; start requires host elevation:" >&2
  echo "  cd '$root' && sudo $compose_command up -d --build" >&2
  return 2
}

blocked=0
stage_one "$CRITICAL_REPLICA_A_NAME" "$CRITICAL_REPLICA_A_SSH" "$CRITICAL_REPLICA_A_ROOT" \
  "$CRITICAL_REPLICA_A_BIND_ADDR" "$CRITICAL_REPLICA_A_CONTAINER" "${CRITICAL_REPLICA_A_DOCKER:-}" || blocked=1
stage_one "$CRITICAL_REPLICA_B_NAME" "$CRITICAL_REPLICA_B_SSH" "$CRITICAL_REPLICA_B_ROOT" \
  "$CRITICAL_REPLICA_B_BIND_ADDR" "$CRITICAL_REPLICA_B_CONTAINER" "${CRITICAL_REPLICA_B_DOCKER:-}" || blocked=1

mkdir -p "$HOME/.config/joelclaw"
python3 - "$CRITICAL_REPLICA_A_NAME" "$CRITICAL_REPLICA_A_URL" "$CRITICAL_REPLICA_B_NAME" "$CRITICAL_REPLICA_B_URL" "$TOKEN_FILE" \
  > "$HOME/.config/joelclaw/critical-search-replicas.json" <<'PY'
import json, sys
name_a, url_a, name_b, url_b, token_file = sys.argv[1:]
print(json.dumps({"tokenFile": token_file, "replicas": [
    {"name": name_a, "url": url_a, "maxStalenessSeconds": 300},
    {"name": name_b, "url": url_b, "maxStalenessSeconds": 300},
]}, indent=2))
PY
chmod 600 "$HOME/.config/joelclaw/critical-search-replicas.json"

"$REPO_ROOT/scripts/replicate-critical-db.sh"
exit "$blocked"
