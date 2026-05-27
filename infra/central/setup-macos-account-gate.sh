#!/usr/bin/env bash
set -euo pipefail

# Prepare a macOS host for ADR-0246 Central shadow runtime.
# This script intentionally does NOT demote Joel or create a passworded admin user.

SERVICE_USER="${SERVICE_USER:-joelclaw}"
SERVICE_FULL_NAME="${SERVICE_FULL_NAME:-JoelClaw Service}"
SERVICE_ROOT="${SERVICE_ROOT:-/Users/Shared/joelclaw}"
SERVICE_HOME="${SERVICE_HOME:-/Users/${SERVICE_USER}}"
SERVICE_UID="${SERVICE_UID:-}"
DRY_RUN=0

usage() {
  cat <<USAGE
Usage: sudo $0 [--dry-run]

Creates/verifies the hidden Standard service user used by launchd Central services,
locks down ${SERVICE_ROOT}, and reports whether a separate non-Joel admin account exists.

Environment overrides:
  SERVICE_USER=${SERVICE_USER}
  SERVICE_FULL_NAME='${SERVICE_FULL_NAME}'
  SERVICE_ROOT=${SERVICE_ROOT}
  SERVICE_HOME=${SERVICE_HOME}
  SERVICE_UID=<explicit uid, optional>
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %q' "$1"
    shift
    for arg in "$@"; do printf ' %q' "$arg"; done
    printf '\n'
  else
    "$@"
  fi
}

require_root() {
  if [[ "$DRY_RUN" == "1" ]]; then
    return
  fi
  if [[ "$(id -u)" != "0" ]]; then
    echo "This script must run as root: sudo $0" >&2
    exit 77
  fi
}

user_exists() {
  dscl . -read "/Users/$1" >/dev/null 2>&1
}

group_has_user() {
  dsmemberutil checkmembership -U "$1" -G "$2" 2>/dev/null | grep -q "is a member"
}

next_uid() {
  dscl . -list /Users UniqueID \
    | awk '$2 >= 500 && $2 < 900 { if ($2 > max) max = $2 } END { print (max ? max + 1 : 502) }'
}

admin_users() {
  dscacheutil -q group -a name admin 2>/dev/null \
    | awk -F: '/users:/ {print $2}' \
    | tr ' ' '\n' \
    | awk 'NF {print}'
}

non_joel_admins() {
  admin_users | grep -Ev '^(root|_mbsetupuser|joel)$' || true
}

create_service_user() {
  if user_exists "$SERVICE_USER"; then
    log "service user exists: $SERVICE_USER"
    return
  fi

  local uid="${SERVICE_UID:-$(next_uid)}"
  log "creating hidden Standard service user: $SERVICE_USER uid=$uid home=$SERVICE_HOME"

  run dscl . -create "/Users/$SERVICE_USER"
  run dscl . -create "/Users/$SERVICE_USER" UserShell /usr/bin/false
  run dscl . -create "/Users/$SERVICE_USER" RealName "$SERVICE_FULL_NAME"
  run dscl . -create "/Users/$SERVICE_USER" UniqueID "$uid"
  run dscl . -create "/Users/$SERVICE_USER" PrimaryGroupID 20
  run dscl . -create "/Users/$SERVICE_USER" NFSHomeDirectory "$SERVICE_HOME"
  run dscl . -create "/Users/$SERVICE_USER" IsHidden 1
  run dscl . -create "/Users/$SERVICE_USER" GeneratedUID "$(uuidgen)"

  # No password hash is set. This account is for launchd UserName ownership, not login.
  run mkdir -p "$SERVICE_HOME"
  run chown "$SERVICE_USER:staff" "$SERVICE_HOME"
  run chmod 700 "$SERVICE_HOME"
}

ensure_not_admin() {
  if group_has_user "$SERVICE_USER" admin; then
    log "removing $SERVICE_USER from admin group"
    run dseditgroup -o edit -d "$SERVICE_USER" -t user admin
  else
    log "service user is not admin: $SERVICE_USER"
  fi
}

ensure_service_root() {
  log "ensuring service root skeleton: $SERVICE_ROOT"
  for dir in "$SERVICE_ROOT" "$SERVICE_ROOT/services" "$SERVICE_ROOT/src" "$SERVICE_ROOT/logs" "$SERVICE_ROOT/backups" "$SERVICE_ROOT/run"; do
    run mkdir -p "$dir"
  done

  if [[ "$DRY_RUN" == "1" ]]; then
    log "would chown/chmod service root"
  else
    chown -R "$SERVICE_USER:staff" "$SERVICE_ROOT"
    find "$SERVICE_ROOT" -type d -exec chmod 700 {} +
    find "$SERVICE_ROOT" -type f -exec chmod 600 {} +
  fi
}

write_receipt() {
  local receipt_dir="$SERVICE_ROOT/run"
  local receipt="$receipt_dir/account-gate-$(date -u +%Y%m%dT%H%M%SZ).txt"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would write receipt: $receipt"
    return
  fi

  cat > "$receipt" <<EOF
host=$(hostname)
date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
service_user=$SERVICE_USER
service_uid=$(id -u "$SERVICE_USER")
service_groups=$(id -Gn "$SERVICE_USER")
service_home=$SERVICE_HOME
service_root=$SERVICE_ROOT
service_root_ls=$(ls -ld "$SERVICE_ROOT")
non_joel_admins=$(non_joel_admins | paste -sd, -)
EOF
  chown "$SERVICE_USER:staff" "$receipt"
  chmod 600 "$receipt"
  log "receipt=$receipt"
}

main() {
  require_root
  log "starting account gate for service user $SERVICE_USER"
  create_service_user
  ensure_not_admin
  ensure_service_root
  write_receipt

  local admins
  admins="$(non_joel_admins | paste -sd, -)"
  if [[ -z "$admins" ]]; then
    log "blocked: no separate non-Joel admin account detected. Do not demote joel. Create/verify admin manually."
    exit 2
  fi

  log "separate non-Joel admin account detected: $admins"
  log "account gate complete"
}

main "$@"
