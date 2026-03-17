#!/bin/sh
# guest-runner.sh — Firecracker microVM one-shot command executor
#
# Runs inside the guest VM at boot. Mounts workspace, executes the
# pre-staged command, writes results, and powers off the VM.
#
# One-shot model (like Lambda):
#   Host: creates workspace ext4 → writes command.sh + request.json → boots VM
#   Guest: mounts workspace → executes command → writes results → poweroff
#   Host: waits for VM exit → reads results from workspace image
#
# Protocol files in /workspace/.joelclaw-microvm/:
#   Input:  command.sh, request.json (written by host before boot)
#   Output: stdout.log, stderr.log, result.json (written by guest before halt)

set -eu

WORKSPACE_DEV="/dev/vdb"
WORKSPACE_MOUNT="/workspace"
PROTOCOL_DIR="$WORKSPACE_MOUNT/.joelclaw-microvm"

log() {
    printf '[guest-runner] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '?')" "$1"
}

# ── Mount workspace ──────────────────────────────────

if [ ! -b "$WORKSPACE_DEV" ]; then
    log "ERROR: $WORKSPACE_DEV not found — no workspace device attached"
    poweroff -f 2>/dev/null || reboot -f
    exit 1
fi

mkdir -p "$WORKSPACE_MOUNT"

if ! mountpoint -q "$WORKSPACE_MOUNT" 2>/dev/null; then
    log "Mounting $WORKSPACE_DEV at $WORKSPACE_MOUNT"
    mount "$WORKSPACE_DEV" "$WORKSPACE_MOUNT"
fi

if ! mountpoint -q "$WORKSPACE_MOUNT" 2>/dev/null; then
    log "ERROR: failed to mount $WORKSPACE_DEV"
    poweroff -f 2>/dev/null || reboot -f
    exit 1
fi

log "Workspace mounted"

# ── Check for command ────────────────────────────────

if [ ! -d "$PROTOCOL_DIR" ]; then
    log "ERROR: protocol dir $PROTOCOL_DIR not found"
    sync
    poweroff -f 2>/dev/null || reboot -f
    exit 1
fi

if [ ! -f "$PROTOCOL_DIR/command.sh" ]; then
    log "ERROR: no command.sh found"
    printf '{"exitCode":127,"stdout":"","stderr":"guest-runner: command.sh not found"}\n' \
        > "$PROTOCOL_DIR/result.json"
    sync
    poweroff -f 2>/dev/null || reboot -f
    exit 1
fi

# ── Read timeout ─────────────────────────────────────

TIMEOUT_S=60
if [ -f "$PROTOCOL_DIR/request.json" ]; then
    RAW_TIMEOUT=$(grep -o '"timeoutMs"[[:space:]]*:[[:space:]]*[0-9]*' \
        "$PROTOCOL_DIR/request.json" 2>/dev/null | grep -o '[0-9]*$' || echo "")
    if [ -n "$RAW_TIMEOUT" ] && [ "$RAW_TIMEOUT" -gt 0 ] 2>/dev/null; then
        TIMEOUT_S=$(( (RAW_TIMEOUT + 999) / 1000 ))
    fi
fi

log "Executing command (timeout=${TIMEOUT_S}s)"

# ── Execute ──────────────────────────────────────────

EXIT_CODE=0
chmod +x "$PROTOCOL_DIR/command.sh"

if command -v timeout >/dev/null 2>&1; then
    timeout "${TIMEOUT_S}s" sh -c \
        "cd $WORKSPACE_MOUNT && sh $PROTOCOL_DIR/command.sh" \
        >"$PROTOCOL_DIR/stdout.log" \
        2>"$PROTOCOL_DIR/stderr.log" \
        || EXIT_CODE=$?
else
    sh -c "cd $WORKSPACE_MOUNT && sh $PROTOCOL_DIR/command.sh" \
        >"$PROTOCOL_DIR/stdout.log" \
        2>"$PROTOCOL_DIR/stderr.log" \
        || EXIT_CODE=$?
fi

if [ "$EXIT_CODE" -eq 124 ]; then
    log "Command timed out after ${TIMEOUT_S}s"
    printf 'command timed out after %ds\n' "$TIMEOUT_S" >>"$PROTOCOL_DIR/stderr.log"
fi

# ── Write result ─────────────────────────────────────

STDOUT_CONTENT=""
STDERR_CONTENT=""
[ -f "$PROTOCOL_DIR/stdout.log" ] && STDOUT_CONTENT=$(cat "$PROTOCOL_DIR/stdout.log")
[ -f "$PROTOCOL_DIR/stderr.log" ] && STDERR_CONTENT=$(cat "$PROTOCOL_DIR/stderr.log")

# JSON escape — handle backslash, quotes, tabs, newlines
escape_json() {
    printf '%s' "$1" | sed \
        -e 's/\\/\\\\/g' \
        -e 's/"/\\"/g' \
        -e 's/	/\\t/g' \
        -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g'
}

ESCAPED_STDOUT=$(escape_json "$STDOUT_CONTENT")
ESCAPED_STDERR=$(escape_json "$STDERR_CONTENT")

printf '{"exitCode":%d,"stdout":"%s","stderr":"%s"}\n' \
    "$EXIT_CODE" "$ESCAPED_STDOUT" "$ESCAPED_STDERR" \
    > "$PROTOCOL_DIR/result.json"

log "Command completed (exit=$EXIT_CODE)"

# ── Halt ─────────────────────────────────────────────

sync
log "Powering off"
poweroff -f 2>/dev/null || reboot -f
