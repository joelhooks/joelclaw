#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export JOELCLAW_VOICE_CONFIG="${JOELCLAW_VOICE_CONFIG:-$HOME/.config/joelclaw/voice-agent.yaml}"
mkdir -p "$(dirname "$JOELCLAW_VOICE_CONFIG")"
if [[ ! -f "$JOELCLAW_VOICE_CONFIG" ]]; then
  cp "$SCRIPT_DIR/config.default.yaml" "$JOELCLAW_VOICE_CONFIG"
fi

# Lease secrets with 2h TTL (enough for a voice session).
# A failed lease prints a JSON error envelope to stdout — never export that as a
# credential. Fail loud instead (a wrong secret is worse than a dead worker).
lease() {
  local val
  val="$(secrets lease "$1" --ttl 2h)" || { echo "FATAL: lease failed for $1" >&2; exit 1; }
  case "$val" in
    '{'*) echo "FATAL: lease for $1 returned an error envelope: ${val:0:120}" >&2; exit 1;;
    '') echo "FATAL: lease for $1 returned empty" >&2; exit 1;;
  esac
  printf '%s' "$val"
}

export LIVEKIT_URL="${LIVEKIT_URL:-$(lease livekit_url)}"
export LIVEKIT_API_KEY="$(lease livekit_api_key)"
export LIVEKIT_API_SECRET="$(lease livekit_api_secret)"
export OPENROUTER_API_KEY="$(lease openrouter_api_key)"
export DEEPGRAM_API_KEY="$(lease deepgram_api_key)"
export ELEVEN_API_KEY="$(lease elevenlabs_api_key)"

# GOG_KEYRING_PASSWORD for calendar/email tools
export GOG_KEYRING_PASSWORD="$(lease gog_keyring_password)"

echo "🎙️  joelclaw voice agent starting..."
echo "   LiveKit: $LIVEKIT_URL"
echo "   Config:  $JOELCLAW_VOICE_CONFIG"
echo ""

uv run python main.py "$@"
