#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export JOELCLAW_VOICE_CONFIG="${JOELCLAW_VOICE_CONFIG:-$HOME/.config/joelclaw/voice-agent.yaml}"
mkdir -p "$(dirname "$JOELCLAW_VOICE_CONFIG")"
if [[ ! -f "$JOELCLAW_VOICE_CONFIG" ]]; then
  cp "$SCRIPT_DIR/config.default.yaml" "$JOELCLAW_VOICE_CONFIG"
fi

# Lease secrets with 2h TTL (enough for a voice session)
export LIVEKIT_URL="ws://127.0.0.1:7880"
export LIVEKIT_API_KEY="$(secrets lease livekit_api_key --ttl 2h)"
export LIVEKIT_API_SECRET="$(secrets lease livekit_api_secret --ttl 2h)"
export OPENROUTER_API_KEY="$(secrets lease openrouter_api_key --ttl 2h)"
export DEEPGRAM_API_KEY="$(secrets lease deepgram_api_key --ttl 2h)"
export ELEVEN_API_KEY="$(secrets lease elevenlabs_api_key --ttl 2h)"

# GOG_KEYRING_PASSWORD for calendar/email tools
export GOG_KEYRING_PASSWORD="$(secrets lease gog_keyring_password --ttl 2h)"

echo "🎙️  joelclaw voice agent starting..."
echo "   LiveKit: $LIVEKIT_URL"
echo "   Config:  $JOELCLAW_VOICE_CONFIG"
echo ""

uv run python main.py "$@"
