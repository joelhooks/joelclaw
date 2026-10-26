#!/bin/bash
# Ring one of Joel's friends and have ShitRat explain a topic, on Joel's behalf.
#
# Usage: printf '%s' "$NUMBER" | call-guest.sh <name> <topic> "<opener>" ["<voicemail line>"]
#   The number comes on stdin, so it never lands in argv, logs or source.
#   <topic> names guest-topics/<topic>.md; that file plus public-context.md is the
#   call's entire context. <opener> is spoken word for word to a person: use the
#   approved text. On voicemail ShitRat says only the approved voicemail line and
#   hangs up; with no line given it hangs up silently. Each dial's name, topic,
#   opener and voicemail line need Joel's go.
#
# Guest mode (main.py, room prefix call-outbound-guest-): trusted as our dial,
# never as Joel. No snapshot, recall, mail, fleet tools or call-backs; only the
# time and hang-up; ten-minute cap. One dial: on no answer it exits 1 and never redials.
set -euo pipefail

NAME="${1:-}"
TOPIC="${2:-}"
OPENER="${3:-}"
VOICEMAIL="${4:-}"
if [ -z "$NAME" ] || [ -z "$TOPIC" ] || [ -z "$OPENER" ]; then
  echo "usage: printf '%s' NUMBER | call-guest.sh <name> <topic> \"<opener>\" [\"<voicemail line>\"]" >&2
  exit 2
fi
# Same rules main.py applies, checked before the phone rings.
[[ "$TOPIC" =~ ^[a-z0-9-]{1,40}$ ]] || { echo "FATAL: topic must match [a-z0-9-]{1,40}" >&2; exit 2; }
[ "${#NAME}" -le 40 ] && [ "${#OPENER}" -le 400 ] && [ "${#VOICEMAIL}" -le 400 ] || { echo "FATAL: name over 40 or opener/voicemail over 400 chars" >&2; exit 2; }
VOICE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
[ -f "$VOICE_DIR/guest-topics/$TOPIC.md" ] || { echo "FATAL: no guest-topics/$TOPIC.md" >&2; exit 2; }

NUMBER="$(tr -d ' ()\t\r\n.-' )"
case "$NUMBER" in
  +[1-9]*) ;;
  [2-9][0-9][0-9][2-9][0-9][0-9][0-9][0-9][0-9][0-9]) NUMBER="+1$NUMBER" ;;
  *) echo "FATAL: need an E.164 number on stdin" >&2; exit 2 ;;
esac

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
OUTBOUND_TRUNK="ST_KAQ9ZS6xW6Fo"
ROOM="call-outbound-guest-$(date +%s)"

REQUEST="$(python3 -I - "$OUTBOUND_TRUNK" "$NUMBER" "$ROOM" "$NAME" "$TOPIC" "$OPENER" "$VOICEMAIL" <<'EOF'
import json, sys
trunk, number, room, name, topic, opener, voicemail = sys.argv[1:8]
print(json.dumps({
    "sip_trunk_id": trunk,
    "sip_call_to": number,
    "room_name": room,
    "participant_identity": "guest",
    "participant_name": name,
    "participant_attributes": {"guest_name": name, "guest_topic": topic, "guest_opener": opener, "guest_voicemail": voicemail},
    "wait_until_answered": True,
    "ringing_timeout": "40s",
    "max_call_duration": "660s",
}))
EOF
)"

echo "Calling $NAME about $TOPIC (room: $ROOM)..."
if ! printf '%s' "$REQUEST" | lk sip participant create - >/dev/null; then
  echo "NO_ANSWER_OR_FAILED room=$ROOM (not redialling)"
  exit 1
fi
echo "ANSWERED room=$ROOM"
