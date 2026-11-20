#!/bin/bash
# Build the guest's /etc/voice-agent/env from agent-secrets and stream it over ssh stdin.
# Never prints values.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/guest.env.sh"
: "${VOICE_FLAGG_HOST:?set VOICE_FLAGG_HOST in $VOICE_GUEST_ENV (the tool gate ssh target)}"

pairs=(LIVEKIT_URL:livekit_url LIVEKIT_API_KEY:livekit_api_key LIVEKIT_API_SECRET:livekit_api_secret
  OPENROUTER_API_KEY:openrouter_api_key DEEPGRAM_API_KEY:deepgram_api_key ELEVEN_API_KEY:elevenlabs_api_key
  TELNYX_PHONE_NUMBER:telnyx_phone_number JOEL_PHONE_NUMBER:joel_phone_number SLACK_USER_TOKEN:slack_user_token)
build() {
  for p in "${pairs[@]}"; do
    var="${p%%:*}"; name="${p#*:}"
    val="$(secrets lease "$name" --ttl 1h)" || { echo "lease failed: $name" >&2; exit 1; }
    case "$val" in '{'*|'') echo "bad lease: $name" >&2; exit 1;; esac
    case "$val" in *'"'*|*$'\n'*) echo "unsafe chars in $name" >&2; exit 1;; esac
    printf '%s="%s"\n' "$var" "$val"
  done
  printf 'VOICE_FLAGG_HOST="%s"\n' "$VOICE_FLAGG_HOST"
}
build | ssh -o BatchMode=yes "$VOICE_GUEST_HOST" "pct exec $VOICE_GUEST_CT -- bash -c 'install -d -m 0755 /etc/voice-agent && umask 077 && tee /etc/voice-agent/env.new >/dev/null && chmod 600 /etc/voice-agent/env.new && mv /etc/voice-agent/env.new /etc/voice-agent/env && cut -d= -f1 /etc/voice-agent/env | tr \"\n\" \" \" && echo && stat -c \"%U %a\" /etc/voice-agent/env'"
