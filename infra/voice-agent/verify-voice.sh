#!/usr/bin/env bash
set -uo pipefail

status=0
failures=()
ROOM=""
LK_ENV=()

probe() {
  local label="$1"; shift
  local tmp
  tmp="$(mktemp -t verify-voice.XXXXXX)"
  if "$@" >"$tmp" 2>&1; then
    printf 'ok   %s\n' "$label"
  else
    printf 'fail %s\n' "$label"
    sed 's/^/     /' "$tmp"
    status=1
    failures+=("$label")
  fi
  rm -f "$tmp"
}

warn_probe() {
  local label="$1"; shift
  local tmp
  tmp="$(mktemp -t verify-voice.XXXXXX)"
  if "$@" >"$tmp" 2>&1; then printf 'ok   %s\n' "$label"
  else printf 'warn %s\n' "$label"; sed 's/^/     /' "$tmp"; fi
  rm -f "$tmp"
}

lease() {
  local value
  value="$(secrets lease "$1" --ttl 5m)" || return 1
  [[ -n "$value" && "$value" != \{* ]] || return 1
  printf '%s' "$value"
}

plist_running() {
  [[ -f "$HOME/Library/LaunchAgents/com.joel.voice-agent.plist" ]] || return 1
  launchctl print "gui/$(id -u)/com.joel.voice-agent" | grep -Eq 'state[[:space:]]*=[[:space:]]*running'
}

gui_session() { launchctl print "gui/$(id -u)" >/dev/null; }
secrets_healthy() { secrets health >/dev/null; }
lease_named() { lease "$1" >/dev/null; }

cleanup_room() {
  if [[ -n "$ROOM" && ${#LK_ENV[@]} -gt 0 ]]; then
    env "${LK_ENV[@]}" /opt/homebrew/bin/lk room delete "$ROOM" >/dev/null 2>&1 || true
  fi
}
trap cleanup_room EXIT

live_dispatch() {
  local url key secret output
  url="$(lease livekit_url)" || return 1
  key="$(lease livekit_api_key)" || return 1
  secret="$(lease livekit_api_secret)" || return 1
  LK_ENV=("LIVEKIT_URL=$url" "LIVEKIT_API_KEY=$key" "LIVEKIT_API_SECRET=$secret")
  ROOM="canary-verify-$(date +%s)"
  env "${LK_ENV[@]}" /opt/homebrew/bin/lk room create "$ROOM" >/dev/null || return 1
  local i
  for i in {1..10}; do
    output="$(env "${LK_ENV[@]}" /opt/homebrew/bin/lk room participants list "$ROOM" 2>/dev/null || true)"
    if grep -Eq 'agent-[[:alnum:]_-]+' <<<"$output"; then return 0; fi
    sleep 2
  done
  printf 'no agent-* participant joined %s within 20s\n' "$ROOM"
  return 1
}

no_recent_fatal() {
  local file="$HOME/.local/log/voice-agent.err"
  [[ ! -f "$file" ]] && return 0
  local age=$(( $(date +%s) - $(stat -f %m "$file") ))
  if [[ "$age" -le 600 ]] && tail -50 "$file" | grep -q 'FATAL:'; then
    tail -50 "$file" | grep 'FATAL:'
    return 1
  fi
}

typesense_healthy() {
  local key url="${TYPESENSE_URL:-http://localhost:8108}"
  key="$(lease typesense_api_key)" || return 1
  curl -fsS -H "X-TYPESENSE-API-KEY: $key" "$url/health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
}

wiki_healthy() { curl -fsS --max-time 5 http://127.0.0.1:8790/latest.json >/dev/null; }

recall_tool_healthy() {
  local root output
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  command -v joelclaw >/dev/null || return 1
  grep -q 'async def recall_work' "$root/main.py" || return 1
  output="$(cd "$root" && uv run python - <<'PY'
from voice_recall import MEMORY_DOWN, NOTHING_DISTILLED, run_recall_work
# This is an index/tool health check, not an unverified-caller privacy check.
# The observation index may legitimately contain only sensitive recent hits;
# verified Joel recall must still prove the tool can read a non-empty index.
result = run_recall_work("*", days=7, caller_verified=True)
if result in {MEMORY_DOWN, NOTHING_DISTILLED}:
    raise SystemExit(1)
print(result)
PY
)" || return 1
  [[ -n "$output" ]]
}

balance_check() {
  local key body credit
  key="$(lease telnyx_api_key)" || return 1
  body="$(curl -fsS -H "Authorization: Bearer $key" https://api.telnyx.com/v2/balance)" || return 1
  credit="$(python3 -c 'import json,sys; print(float(json.load(sys.stdin)["data"]["available_credit"]))' <<<"$body")" || return 1
  python3 - "$credit" <<'PY'
import sys
credit = float(sys.argv[1])
print(f"available_credit=${credit:.2f}")
raise SystemExit(1 if credit < 10 else 0)
PY
}

balance_warn() {
  local key body credit
  key="$(lease telnyx_api_key)" || return 1
  body="$(curl -fsS -H "Authorization: Bearer $key" https://api.telnyx.com/v2/balance)" || return 1
  credit="$(python3 -c 'import json,sys; print(float(json.load(sys.stdin)["data"]["available_credit"]))' <<<"$body")" || return 1
  python3 - "$credit" <<'PY'
import sys
credit = float(sys.argv[1])
print(f"available_credit=${credit:.2f}")
raise SystemExit(1 if credit < 25 else 0)
PY
}

config_has_callers() {
  local config="$HOME/.config/joelclaw/voice-agent.yaml"
  [[ -f "$config" ]] || return 1
  # System python3 has no PyYAML; the worker venv (built by run.sh/uv) does.
  local py="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.venv/bin/python"
  [[ -x "$py" ]] || py=python3
  "$py" - "$config" <<'PY'
import sys, yaml
with open(sys.argv[1]) as f:
    data = yaml.safe_load(f) or {}
callers = (data.get("security") or {}).get("allowed_callers")
raise SystemExit(0 if isinstance(callers, list) and any(str(v).strip() for v in callers) else 1)
PY
}

printf 'Voice verification\nhost=%s user=%s\n\n' "$(hostname)" "$(id -un)"
probe 'voice LaunchAgent installed and running' plist_running
probe 'GUI launchd session available' gui_session
probe 'agent-secrets healthy' secrets_healthy
for secret in livekit_url livekit_api_key livekit_api_secret openrouter_api_key deepgram_api_key elevenlabs_api_key gog_keyring_password slack_user_token telnyx_api_key telnyx_phone_number joel_phone_number; do
  probe "secret leases: $secret" lease_named "$secret"
done
probe 'LiveKit worker dispatch registered' live_dispatch
probe 'no recent voice-agent FATAL crash loop' no_recent_fatal
probe 'Typesense healthy' typesense_healthy
probe 'voice recall tool registered with non-empty observation index' recall_tool_healthy
warn_probe 'wiki edition endpoint healthy' wiki_healthy
probe 'Telnyx available credit at least $10' balance_check
warn_probe 'Telnyx available credit at least $25' balance_warn
probe 'voice config has allowed callers' config_has_callers

if [[ "$status" -ne 0 ]]; then
  joined="$(IFS=', '; echo "${failures[*]}")"
  joelclaw send notification/call.requested "{\"message\":\"verify-voice FAILED on flagg: $joined\"}" || true
  joelclaw notify send "verify-voice FAILED: $joined" --priority urgent || true
fi
exit "$status"
