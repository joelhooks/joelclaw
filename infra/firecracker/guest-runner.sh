#!/bin/sh
# guest-runner.sh — Firecracker microVM command execution daemon
#
# Runs inside the guest VM. Watches a shared workspace for commands
# from the host-side exec protocol (microvm.ts execInMicroVm).
#
# Protocol:
#   Host writes: command.sh, request.json, run.signal → .joelclaw-microvm/
#   Guest reads:  run.signal triggers execution of command.sh
#   Guest writes: stdout.log, stderr.log, result.json → .joelclaw-microvm/
#   Host polls:   result.json for completion
#
# This script is started by busybox init (::respawn) so it auto-restarts
# on crash. It exits non-zero if /dev/vdb is missing (no workspace).

set -eu

WORKSPACE_DEV="/dev/vdb"
WORKSPACE_MOUNT="/workspace"
PROTOCOL_DIR="$WORKSPACE_MOUNT/.joelclaw-microvm"
POLL_INTERVAL_MS=100  # approximate via usleep/sleep

log() {
    printf '[guest-runner] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "?")" "$1"
}

# ── Mount workspace ──────────────────────────────────

if [ ! -b "$WORKSPACE_DEV" ]; then
    log "ERROR: $WORKSPACE_DEV not found — no workspace device attached"
    exit 1
fi

mkdir -p "$WORKSPACE_MOUNT"

if ! mountpoint -q "$WORKSPACE_MOUNT" 2>/dev/null; then
    log "Mounting $WORKSPACE_DEV at $WORKSPACE_MOUNT"
    mount "$WORKSPACE_DEV" "$WORKSPACE_MOUNT"
fi

if ! mountpoint -q "$WORKSPACE_MOUNT" 2>/dev/null; then
    log "ERROR: failed to mount $WORKSPACE_DEV"
    exit 1
fi

log "Workspace mounted at $WORKSPACE_MOUNT"

# ── Ensure protocol dir exists ───────────────────────

mkdir -p "$PROTOCOL_DIR"
log "Watching $PROTOCOL_DIR for commands"

# ── Poll loop ────────────────────────────────────────

while true; do
    # Wait for signal file
    if [ ! -f "$PROTOCOL_DIR/run.signal" ]; then
        # Sleep ~100ms (busybox usleep takes microseconds)
        if command -v usleep >/dev/null 2>&1; then
            usleep "$((POLL_INTERVAL_MS * 1000))"
        else
            sleep 0.1
        fi
        continue
    fi

    log "Signal received — executing command"

    # Read timeout from request.json if available
    TIMEOUT_S=60
    if [ -f "$PROTOCOL_DIR/request.json" ]; then
        # Extract timeoutMs with basic tools (no jq guaranteed)
        RAW_TIMEOUT=$(grep -o '"timeoutMs"[[:space:]]*:[[:space:]]*[0-9]*' "$PROTOCOL_DIR/request.json" 2>/dev/null | grep -o '[0-9]*$' || echo "")
        if [ -n "$RAW_TIMEOUT" ] && [ "$RAW_TIMEOUT" -gt 0 ] 2>/dev/null; then
            TIMEOUT_S=$(( (RAW_TIMEOUT + 999) / 1000 ))  # ceil to seconds
        fi
    fi

    # Clean previous results
    rm -f "$PROTOCOL_DIR/result.json" \
          "$PROTOCOL_DIR/stdout.log" \
          "$PROTOCOL_DIR/stderr.log"

    # Execute command with timeout
    EXIT_CODE=0
    if [ -f "$PROTOCOL_DIR/command.sh" ]; then
        chmod +x "$PROTOCOL_DIR/command.sh"

        if command -v timeout >/dev/null 2>&1; then
            timeout "${TIMEOUT_S}s" sh -c \
                "cd $WORKSPACE_MOUNT && sh $PROTOCOL_DIR/command.sh" \
                >"$PROTOCOL_DIR/stdout.log" \
                2>"$PROTOCOL_DIR/stderr.log" \
                || EXIT_CODE=$?
        else
            # Fallback without timeout command
            sh -c "cd $WORKSPACE_MOUNT && sh $PROTOCOL_DIR/command.sh" \
                >"$PROTOCOL_DIR/stdout.log" \
                2>"$PROTOCOL_DIR/stderr.log" \
                || EXIT_CODE=$?
        fi

        # timeout returns 124 on timeout
        if [ "$EXIT_CODE" -eq 124 ]; then
            log "Command timed out after ${TIMEOUT_S}s"
            printf 'command timed out after %ds\n' "$TIMEOUT_S" >>"$PROTOCOL_DIR/stderr.log"
        fi
    else
        log "ERROR: no command.sh found"
        EXIT_CODE=127
        printf 'guest-runner: command.sh not found\n' >"$PROTOCOL_DIR/stderr.log"
    fi

    # Read captured output for result.json
    STDOUT_CONTENT=""
    STDERR_CONTENT=""
    if [ -f "$PROTOCOL_DIR/stdout.log" ]; then
        STDOUT_CONTENT=$(cat "$PROTOCOL_DIR/stdout.log")
    fi
    if [ -f "$PROTOCOL_DIR/stderr.log" ]; then
        STDERR_CONTENT=$(cat "$PROTOCOL_DIR/stderr.log")
    fi

    # Write result.json — escape special chars for valid JSON
    # Using printf + sed for JSON escaping without jq
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

    log "Command completed (exit=$EXIT_CODE), result written"

    # Remove signal — ready for next command
    rm -f "$PROTOCOL_DIR/run.signal"
done
