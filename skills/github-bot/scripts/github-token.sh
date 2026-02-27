#!/usr/bin/env bash
# Generate a GitHub App installation access token.
# Outputs the token to stdout. Expires in 1 hour.
#
# Usage: ./github-token.sh
#
# Requires: openssl, curl, /Users/joel/.local/bin/secrets

set -euo pipefail

SECRETS=/Users/joel/.local/bin/secrets

lease_value() {
  "$SECRETS" lease "$1" --ttl 2m --output json 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['value'])"
}

APP_ID=$(lease_value github_app_id)
INSTALL_ID=$(lease_value github_app_installation_id)
PEM=$(lease_value github_app_pem)

# Write PEM to temp file for openssl
TMPKEY=$(mktemp)
trap 'rm -f "$TMPKEY"' EXIT
echo "$PEM" > "$TMPKEY"

# Build JWT (10 min expiry)
NOW=$(date +%s)
HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e | tr -d '=\n' | tr '/+' '_-')
PAYLOAD=$(echo -n "{\"iat\":$((NOW-60)),\"exp\":$((NOW+300)),\"iss\":\"${APP_ID}\"}" | openssl base64 -e | tr -d '=\n' | tr '/+' '_-')
SIGNATURE=$(echo -n "${HEADER}.${PAYLOAD}" | openssl dgst -sha256 -sign "$TMPKEY" | openssl base64 -e | tr -d '=\n' | tr '/+' '_-')
JWT="${HEADER}.${PAYLOAD}.${SIGNATURE}"

# Exchange JWT for installation token
RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${INSTALL_ID}/access_tokens")

echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])"
