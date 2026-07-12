#!/bin/bash
# Ring Joel's phone and connect him to ShitRat (the joelclaw voice agent).
#
# Usage: call-joel.sh [reason for the call...]
#   The reason is passed to ShitRat, who opens the call with it.
#
# Runs on flagg (needs lk, agent-secrets, and the registered voice worker).
# From other fleet machines: ssh flagg '~/Code/joelhooks/joelclaw/infra/voice-agent/call-joel.sh "reason"'
set -euo pipefail

REASON="${*:-}"

lease() {
  local val
  val="$(secrets lease "$1" --ttl 10m)" || { echo "FATAL: lease failed for $1" >&2; exit 1; }
  case "$val" in
    '{'*|'') echo "FATAL: bad lease for $1" >&2; exit 1;;
  esac
  printf '%s' "$val"
}

export LIVEKIT_URL="$(lease livekit_url)"
export LIVEKIT_API_KEY="$(lease livekit_api_key)"
export LIVEKIT_API_SECRET="$(lease livekit_api_secret)"
JOEL_NUMBER="$(lease joel_phone_number)"
OUTBOUND_TRUNK="ST_KAQ9ZS6xW6Fo"
ROOM="call-outbound-joel-$(date +%s)"

REQUEST="$(python3 - "$OUTBOUND_TRUNK" "$JOEL_NUMBER" "$ROOM" "$REASON" <<'EOF'
import json, sys
trunk, number, room, reason = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
req = {
    "sip_trunk_id": trunk,
    "sip_call_to": number,
    "room_name": room,
    "participant_identity": "joel-cell",
    "participant_name": "Joel",
    "wait_until_answered": True,
}
if reason.strip():
    req["participant_attributes"] = {"call_reason": reason.strip()}
print(json.dumps(req))
EOF
)"

echo "Calling Joel (room: $ROOM)..."
printf '%s' "$REQUEST" | lk sip participant create -
