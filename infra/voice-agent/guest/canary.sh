#!/bin/bash
# Same check as verify-voice.sh live_dispatch: create a room, wait for an agent-* participant.
set -euo pipefail
LK="$(command -v lk || echo /opt/homebrew/bin/lk)"
export LIVEKIT_URL="$(secrets lease livekit_url --ttl 15m)"
export LIVEKIT_API_KEY="$(secrets lease livekit_api_key --ttl 15m)"
export LIVEKIT_API_SECRET="$(secrets lease livekit_api_secret --ttl 15m)"
ROOM="canary-verify-guest-$(date +%s)"
"$LK" room create "$ROOM" >/dev/null
started=$SECONDS
while (( SECONDS - started < 45 )); do
  out="$("$LK" room participants list "$ROOM" 2>/dev/null || true)"
  if grep -Eq 'agent-[[:alnum:]_-]+' <<<"$out"; then
    echo "PASS agent joined $ROOM after $((SECONDS - started))s"
    "$LK" room delete "$ROOM" >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done
echo "FAIL no agent joined $ROOM within 45s"
"$LK" room delete "$ROOM" >/dev/null 2>&1 || true
exit 1
