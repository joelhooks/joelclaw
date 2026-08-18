#!/bin/bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run once as root: sudo $0"
  exit 1
fi

LABEL="com.joel.agent-secrets"
OPERATOR_USER="${OPERATOR_USER:-joel}"
OPERATOR_HOME="${OPERATOR_HOME:-/Users/${OPERATOR_USER}}"
SERVICE_USER="${SERVICE_USER:-joelclaw}"
SERVICE_HOME="${SERVICE_HOME:-/Users/${SERVICE_USER}}"
SOCKET_GROUP="${SOCKET_GROUP:-joelclaw-secrets}"
SERVICE_ROOT="${SERVICE_ROOT:-/Users/Shared/joelclaw}"
SOCKET_PATH="${SOCKET_PATH:-${SERVICE_ROOT}/run/agent-secrets.sock}"
REPO_ROOT="${REPO_ROOT:-${OPERATOR_HOME}/Code/joelhooks/joelclaw}"
SOURCE_PLIST="${REPO_ROOT}/infra/launchd/${LABEL}.plist"
LIVE_PLIST="/Library/LaunchDaemons/${LABEL}.plist"
PLIST_BACKUP="${LIVE_PLIST}.pre-service-account"
CLIENT_CONFIG="${OPERATOR_HOME}/.agent-secrets/config.json"
CLIENT_CONFIG_BACKUP="${CLIENT_CONFIG}.pre-service-account"
RUN_PLIST_BACKUP=""
RUN_CLIENT_CONFIG_BACKUP=""
RUN_CLIENT_CONFIG_EXISTED=0
SOURCE_STORE="${OPERATOR_HOME}/.agent-secrets"
SERVICE_STORE="${SERVICE_HOME}/.agent-secrets"
SOURCE_BINARY="${OPERATOR_HOME}/.local/bin/secrets"
SERVICE_BINARY="${SERVICE_ROOT}/bin/secrets"
SHITRAT_BINARY="${OPERATOR_HOME}/.local/bin/shitrat"
JQ_BIN="${JQ_BIN:-/opt/homebrew/bin/jq}"
CUTOVER_STARTED=0
GROUP_MEMBERSHIP_CHANGED=0
FIRST_MIGRATION=0
MIGRATION_MARKER="${SERVICE_STORE}/service-account-migration.json"

require() {
  [ -e "$1" ] || { echo "Missing required path: $1"; exit 1; }
}

restore_operator_config() {
  if [ "$RUN_CLIENT_CONFIG_EXISTED" -eq 1 ] && [ -f "$RUN_CLIENT_CONFIG_BACKUP" ]; then
    install -o "$OPERATOR_USER" -g staff -m 600 "$RUN_CLIENT_CONFIG_BACKUP" "$CLIENT_CONFIG"
  else
    rm -f "$CLIENT_CONFIG"
  fi
}

rollback() {
  local exit_code=$?
  local rollback_failed=0
  trap - ERR
  set +e
  if [ "$CUTOVER_STARTED" -eq 1 ]; then
    echo "Cutover failed; restoring the Joel-owned daemon" >&2
    launchctl bootout "system/${LABEL}" >/dev/null 2>&1
    restore_operator_config || rollback_failed=1
    if [ -n "$RUN_PLIST_BACKUP" ] && [ -f "$RUN_PLIST_BACKUP" ]; then
      if [ "$FIRST_MIGRATION" -eq 1 ] && [ -d "$SERVICE_STORE" ]; then
        mv "$SERVICE_STORE" "${SERVICE_STORE}.rolled-back.$(date -u +%Y%m%dT%H%M%SZ)" || rollback_failed=1
      fi
      install -o root -g wheel -m 644 "$RUN_PLIST_BACKUP" "$LIVE_PLIST" || rollback_failed=1
      launchctl bootstrap system "$LIVE_PLIST" >/dev/null 2>&1 || rollback_failed=1
      launchctl kickstart -k "system/${LABEL}" >/dev/null 2>&1 || rollback_failed=1
      for _ in $(seq 1 15); do
        sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check status >/dev/null 2>&1 && break
        sleep 1
      done
      sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check status >/dev/null 2>&1 || rollback_failed=1
    else
      rollback_failed=1
    fi
  fi
  if [ "$rollback_failed" -ne 0 ]; then
    echo "CRITICAL: rollback did not restore a healthy agent-secrets daemon" >&2
    exit 70
  fi
  exit "$exit_code"
}
trap rollback ERR

require "$SOURCE_PLIST"
require "$SOURCE_BINARY"
require "$SHITRAT_BINARY"
require "$SOURCE_STORE/identity.age"
require "$SOURCE_STORE/secrets.age"
require "$JQ_BIN"
/usr/bin/plutil -lint "$SOURCE_PLIST" >/dev/null
id "$SERVICE_USER" >/dev/null
"$SOURCE_BINARY" daemon restart --help >/dev/null 2>&1 || {
  echo "Installed secrets binary lacks service-account restart support: $SOURCE_BINARY" >&2
  exit 1
}

group_has_member() {
  /usr/bin/dscl . -read "/Groups/${SOCKET_GROUP}" GroupMembership 2>/dev/null \
    | cut -d: -f2- \
    | tr ' ' '\n' \
    | grep -Fxq "$1"
}

if ! /usr/bin/dscl . -read "/Groups/${SOCKET_GROUP}" >/dev/null 2>&1; then
  /usr/sbin/dseditgroup -o create -r "Agent Secrets socket clients" "$SOCKET_GROUP"
  GROUP_MEMBERSHIP_CHANGED=1
fi
for user in "$OPERATOR_USER" "$SERVICE_USER"; do
  if ! group_has_member "$user"; then
    /usr/sbin/dseditgroup -o edit -a "$user" -t user "$SOCKET_GROUP"
    GROUP_MEMBERSHIP_CHANGED=1
  fi
done
for member in $(/usr/bin/dscl . -read "/Groups/${SOCKET_GROUP}" GroupMembership | cut -d: -f2-); do
  case "$member" in
    "$OPERATOR_USER"|"$SERVICE_USER") ;;
    *) echo "Unexpected ${SOCKET_GROUP} member: $member" >&2; exit 1 ;;
  esac
done
nested_groups="$(/usr/bin/dscl . -read "/Groups/${SOCKET_GROUP}" NestedGroups 2>/dev/null | cut -d: -f2- | xargs || true)"
[ -z "$nested_groups" ] || {
  echo "Unexpected ${SOCKET_GROUP} nested groups: $nested_groups" >&2
  exit 1
}

if [ "$GROUP_MEMBERSHIP_CHANGED" -eq 1 ]; then
  cat <<EOF
Prepared ${SOCKET_GROUP} membership for ${OPERATOR_USER} and ${SERVICE_USER}.
Restart Joel's login/session processes so they receive the new supplementary group, then rerun:
  sudo $0
No daemon or store was changed in this preparation pass.
EOF
  exit 75
fi

require "$LIVE_PLIST"
RUN_PLIST_BACKUP="$(mktemp /var/tmp/agent-secrets-plist.XXXXXX)"
cp -p "$LIVE_PLIST" "$RUN_PLIST_BACKUP"
if [ ! -f "$PLIST_BACKUP" ]; then
  cp -p "$LIVE_PLIST" "$PLIST_BACKUP"
fi
if [ -f "$CLIENT_CONFIG" ]; then
  RUN_CLIENT_CONFIG_EXISTED=1
  RUN_CLIENT_CONFIG_BACKUP="$(mktemp /var/tmp/agent-secrets-client-config.XXXXXX)"
  cp -p "$CLIENT_CONFIG" "$RUN_CLIENT_CONFIG_BACKUP"
  if [ ! -f "$CLIENT_CONFIG_BACKUP" ]; then
    cp -p "$CLIENT_CONFIG" "$CLIENT_CONFIG_BACKUP"
  fi
fi

CUTOVER_STARTED=1
launchctl bootout "system/${LABEL}" >/dev/null 2>&1 || true
sleep 1

install -d -o "$SERVICE_USER" -g "$SOCKET_GROUP" -m 755 "${SERVICE_ROOT}/bin"
install -d -o "$SERVICE_USER" -g "$SOCKET_GROUP" -m 700 "${SERVICE_ROOT}/logs"
install -d -o "$SERVICE_USER" -g "$SOCKET_GROUP" -m 710 "${SERVICE_ROOT}/run"
install -o "$SERVICE_USER" -g "$SOCKET_GROUP" -m 755 "$SOURCE_BINARY" "$SERVICE_BINARY"

if [ ! -f "${SERVICE_STORE}/secrets.age" ]; then
  FIRST_MIGRATION=1
  if [ -d "$SERVICE_STORE" ]; then
    mv "$SERVICE_STORE" "${SERVICE_STORE}.partial.$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  staged_store="$(mktemp -d "${SERVICE_HOME}/.agent-secrets.migrate.XXXXXX")"
  chown "$SERVICE_USER:$SOCKET_GROUP" "$staged_store"
  chmod 700 "$staged_store"
  for name in identity.age secrets.age leases.json audit.log; do
    source_path="${SOURCE_STORE}/${name}"
    [ -f "$source_path" ] || continue
    install -o "$SERVICE_USER" -g "$SOCKET_GROUP" -m 600 "$source_path" "${staged_store}/${name}"
  done
  marker_tmp="$(mktemp)"
  "$JQ_BIN" -n \
    --arg identity_sha256 "$(shasum -a 256 "${staged_store}/identity.age" | awk '{print $1}')" \
    --arg secrets_sha256 "$(shasum -a 256 "${staged_store}/secrets.age" | awk '{print $1}')" \
    --arg migrated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{version: 1, identity_sha256: $identity_sha256, secrets_sha256: $secrets_sha256, migrated_at: $migrated_at}' \
    >"$marker_tmp"
  install -o "$SERVICE_USER" -g "$SOCKET_GROUP" -m 600 "$marker_tmp" "${staged_store}/service-account-migration.json"
  rm -f "$marker_tmp"
  mv "$staged_store" "$SERVICE_STORE"
else
  require "$MIGRATION_MARKER"
  expected_identity="$($JQ_BIN -r '.identity_sha256' "$MIGRATION_MARKER")"
  [ "$(shasum -a 256 "${SERVICE_STORE}/identity.age" | awk '{print $1}')" = "$expected_identity" ] || {
    echo "Service identity does not match migration provenance" >&2
    exit 1
  }
fi

service_config_tmp="$(mktemp)"
cat >"$service_config_tmp" <<JSON
{
  "directory": "${SERVICE_STORE}",
  "socket_path": "${SOCKET_PATH}",
  "socket_mode": "0660",
  "socket_group": "${SOCKET_GROUP}",
  "identity_path": "${SERVICE_STORE}/identity.age",
  "secrets_path": "${SERVICE_STORE}/secrets.age",
  "audit_path": "${SERVICE_STORE}/audit.log",
  "leases_path": "${SERVICE_STORE}/leases.json"
}
JSON
install -o "$SERVICE_USER" -g "$SOCKET_GROUP" -m 600 "$service_config_tmp" "${SERVICE_STORE}/config.json"
rm -f "$service_config_tmp"

client_config_tmp="$(mktemp)"
if [ -f "$CLIENT_CONFIG" ]; then
  "$JQ_BIN" --arg socket "$SOCKET_PATH" '. + {socket_path: $socket}' "$CLIENT_CONFIG" >"$client_config_tmp"
else
  "$JQ_BIN" -n --arg socket "$SOCKET_PATH" '{socket_path: $socket}' >"$client_config_tmp"
fi
install -o "$OPERATOR_USER" -g staff -m 600 "$client_config_tmp" "$CLIENT_CONFIG"
rm -f "$client_config_tmp"

install -o root -g wheel -m 644 "$SOURCE_PLIST" "$LIVE_PLIST"
launchctl bootstrap system "$LIVE_PLIST"
launchctl kickstart -k "system/${LABEL}" >/dev/null 2>&1 || true

for _ in $(seq 1 30); do
  if sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check status >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check status >/dev/null
sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check list >/dev/null
sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check audit --tail 1 >/dev/null
probe_name="__service_account_migration_probe_$$"
sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check add "$probe_name" --value probe-v1 >/dev/null
sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check update "$probe_name" --value probe-v2 >/dev/null
sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check delete "$probe_name" --force >/dev/null
sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check lease shitrat_github_app_id --ttl 5m --client-id service-account-migration >/dev/null

if [ "$FIRST_MIGRATION" -eq 1 ]; then
  sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" "$SOURCE_BINARY" --no-update-check daemon restart >/dev/null
  launchctl kickstart -k system/com.joel.gateway >/dev/null 2>&1
  for _ in $(seq 1 30); do
    launchctl print system/com.joel.gateway 2>/dev/null | grep -q 'state = running' && break
    sleep 1
  done
  launchctl print system/com.joel.gateway | grep -q 'state = running'
fi
sudo -u "$OPERATOR_USER" HOME="$OPERATOR_HOME" PATH="${OPERATOR_HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$SHITRAT_BINARY" status joelhooks/pi-tools >/dev/null

socket_owner="$(stat -f '%Su' "$SOCKET_PATH")"
socket_group="$(stat -f '%Sg' "$SOCKET_PATH")"
socket_mode="$(stat -f '%Lp' "$SOCKET_PATH")"
[ "$socket_owner" = "$SERVICE_USER" ]
[ "$socket_group" = "$SOCKET_GROUP" ]
[ "$socket_mode" = "660" ]

pid="$(/usr/sbin/lsof -t "$SOCKET_PATH" | head -1)"
[ -n "$pid" ]
[ "$(ps -p "$pid" -o user= | tr -d ' ')" = "$SERVICE_USER" ]

[ -z "$RUN_PLIST_BACKUP" ] || rm -f "$RUN_PLIST_BACKUP"
[ -z "$RUN_CLIENT_CONFIG_BACKUP" ] || rm -f "$RUN_CLIENT_CONFIG_BACKUP"
CUTOVER_STARTED=0
trap - ERR
cat <<EOF
agent-secrets service-account cutover verified.
  process owner: ${SERVICE_USER}
  store: ${SERVICE_STORE}
  socket: ${SOCKET_PATH} (${socket_owner}:${socket_group} ${socket_mode})
  old store retained: ${SOURCE_STORE}
  routine restart: secrets daemon restart
  break glass: sudo launchctl kickstart -k system/${LABEL}
  note: operator processes started before group preparation must be restarted
EOF
