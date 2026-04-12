#!/bin/bash
set -euo pipefail

TARGET_USER="${TARGET_USER:-joel}"
TARGET_HOME="${TARGET_HOME:-/Users/${TARGET_USER}}"
TARGET_UID="$(id -u "$TARGET_USER")"
REPO_ROOT="${REPO_ROOT:-${TARGET_HOME}/Code/joelhooks/joelclaw}"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-${TARGET_HOME}/Library/LaunchAgents}"
LOG_DIR="${TARGET_HOME}/.local/log"
LOG_FILE="${LOG_DIR}/headless-bootstrap.log"
PATH="/opt/homebrew/bin:${TARGET_HOME}/.local/bin:${TARGET_HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"
}

require_plist() {
  local path="$1"
  if [ ! -f "$path" ]; then
    log "missing plist: $path"
    return 1
  fi
}

gui_domain_present() {
  launchctl print "gui/${TARGET_UID}" >/dev/null 2>&1
}

user_service_loaded() {
  local label="$1"
  launchctl print "user/${TARGET_UID}/${label}" >/dev/null 2>&1
}

bootstrap_user_service() {
  local label="$1"
  local plist_path="$2"

  require_plist "$plist_path" || return 1

  if user_service_loaded "$label"; then
    log "kickstart user/${TARGET_UID}/${label}"
    launchctl kickstart -k "user/${TARGET_UID}/${label}" >>"$LOG_FILE" 2>&1 || {
      log "WARNING: kickstart failed for ${label}"
      return 1
    }
    return 0
  fi

  log "bootstrap user/${TARGET_UID} ${plist_path}"
  launchctl bootstrap "user/${TARGET_UID}" "$plist_path" >>"$LOG_FILE" 2>&1 || {
    log "WARNING: bootstrap failed for ${label}"
    return 1
  }

  return 0
}

bootout_user_service() {
  local label="$1"
  local plist_path="$2"

  if ! user_service_loaded "$label"; then
    return 0
  fi

  log "bootout user/${TARGET_UID} ${plist_path}"
  launchctl bootout "user/${TARGET_UID}" "$plist_path" >>"$LOG_FILE" 2>&1 || {
    log "WARNING: bootout failed for ${label}"
    return 1
  }

  return 0
}

if [ "$(id -u)" -ne 0 ]; then
  log "headless bootstrap must run as root"
  exit 1
fi

SERVICES=(
  "com.joel.colima:${LAUNCH_AGENTS_DIR}/com.joel.colima.plist"
  "com.joel.k8s-reboot-heal:${LAUNCH_AGENTS_DIR}/com.joel.k8s-reboot-heal.plist"
  "com.joel.agent-secrets:${LAUNCH_AGENTS_DIR}/com.joel.agent-secrets.plist"
  "com.joel.system-bus-worker:${LAUNCH_AGENTS_DIR}/com.joel.system-bus-worker.plist"
  "com.joel.gateway:${LAUNCH_AGENTS_DIR}/com.joel.gateway.plist"
  "com.joel.typesense-portforward:${LAUNCH_AGENTS_DIR}/com.joel.typesense-portforward.plist"
  "com.joelclaw.agent-mail:${LAUNCH_AGENTS_DIR}/com.joelclaw.agent-mail.plist"
)

log "headless bootstrap tick"

if ! launchctl print "user/${TARGET_UID}" >/dev/null 2>&1; then
  log "user/${TARGET_UID} domain unavailable; skipping"
  exit 0
fi

if gui_domain_present; then
  log "gui/${TARGET_UID} present; releasing temporary user-domain launch agents"
  for service in "${SERVICES[@]}"; do
    label="${service%%:*}"
    plist_path="${service#*:}"
    bootout_user_service "$label" "$plist_path" || true
  done
  exit 0
fi

log "gui/${TARGET_UID} absent; bootstrapping critical services into user/${TARGET_UID}"
for service in "${SERVICES[@]}"; do
  label="${service%%:*}"
  plist_path="${service#*:}"
  bootstrap_user_service "$label" "$plist_path" || true
done

log "headless bootstrap tick complete"
