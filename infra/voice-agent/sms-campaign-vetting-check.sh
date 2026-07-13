#!/usr/bin/env bash
# Daily check: is the public-line 10DLC campaign through carrier vetting?
# When it clears, attach the public DID to the campaign and DM Joel.
# Idempotent — exits quietly if the number is already attached or vetting
# is still pending. Safe to run forever; remove the LaunchAgent
# (com.joelclaw.sms-vetting-check) after success.
set -euo pipefail

CAMPAIGN_ID="4b30019f-5c00-f617-8e3c-bda78fb2fda1"
# Superseded first attempt (missing subUsecases, undeletable while TCR_PENDING);
# we retry deleting it each run until Telnyx lets go of it.
OLD_CAMPAIGN_ID="4b30019f-5bf8-c0c8-c836-616b50a35694"
PUBLIC_DID="+13609258342"
NOTIFY="/opt/homebrew/bin/joelclaw"

lease() {
  local value
  value="$(secrets lease "$1" --ttl 5m)" || { echo "FATAL: lease failed for $1" >&2; exit 1; }
  case "$value" in '{'*|'') echo "FATAL: bad lease for $1" >&2; exit 1;; esac
  printf '%s' "$value"
}

notify() {
  if [ -x "$NOTIFY" ] || command -v joelclaw >/dev/null 2>&1; then
    joelclaw notify send --priority normal "$1" || true
  fi
}

API_KEY="$(lease telnyx_api_key)"

# Best-effort cleanup of the superseded campaign; quiet on any outcome.
curl -sS -X DELETE -H "Authorization: Bearer $API_KEY" \
  "https://api.telnyx.com/v2/10dlc/campaign/$OLD_CAMPAIGN_ID" >/dev/null 2>&1 || true

# Already attached? Then we're done — quiet exit.
assigned="$(curl -fsS -H "Authorization: Bearer $API_KEY" \
  "https://api.telnyx.com/v2/10dlc/phone_number_campaigns?filter%5BtelephoneNumber%5D=$(printf '%s' "$PUBLIC_DID" | sed 's/+/%2B/')" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); recs=d.get("records") or d.get("data") or []; print(len(recs))' 2>/dev/null || echo 0)"
if [ "$assigned" != "0" ]; then
  exit 0
fi

# Try the attach. 10036 = still vetting, 10007 = Telnyx transient — both
# quiet, we just try again tomorrow. Success = notify Joel.
response="$(curl -sS -X POST \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d "{\"phoneNumber\":\"$PUBLIC_DID\",\"campaignId\":\"$CAMPAIGN_ID\"}" \
  "https://api.telnyx.com/v2/10dlc/phone_number_campaigns")"

if printf '%s' "$response" | grep -qE '"10036"|"10007"'; then
  exit 0
fi

if printf '%s' "$response" | grep -q '"errors"'; then
  notify "ShitRat SMS: 10DLC attach for $PUBLIC_DID failed with an unexpected error — check campaign $CAMPAIGN_ID. $(printf '%s' "$response" | head -c 300)"
  echo "$response" >&2
  exit 1
fi

notify "ShitRat SMS: 10DLC campaign cleared vetting — $PUBLIC_DID is attached and the public line can send texts. Next: build the docent reply handler (see ~/.brain/projects/public-shitrat-line-sms.svx). You can remove LaunchAgent com.joelclaw.sms-vetting-check."
echo "attached: $response"
