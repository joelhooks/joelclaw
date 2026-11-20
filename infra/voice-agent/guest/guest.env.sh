# Sourced by the guest scripts. Host names stay in a private file outside the repo.
VOICE_GUEST_ENV="${VOICE_GUEST_ENV:-$HOME/.config/joelclaw/voice-worker-host.env}"
if [[ -f "$VOICE_GUEST_ENV" ]]; then
  # shellcheck source=/dev/null
  source "$VOICE_GUEST_ENV"
fi
: "${VOICE_GUEST_HOST:?set VOICE_GUEST_HOST in $VOICE_GUEST_ENV (ssh target that runs pct)}"
: "${VOICE_GUEST_CT:?set VOICE_GUEST_CT in $VOICE_GUEST_ENV (container id)}"

# Run a root shell command inside the guest.
guest() { ssh -o BatchMode=yes "$VOICE_GUEST_HOST" "pct exec $VOICE_GUEST_CT -- bash -c $(printf '%q' "$1")"; }
