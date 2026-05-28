#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_smoke_command curl
require_smoke_command jq
require_secret_env TYPESENSE_API_KEY

collection="$(smoke_id)_typesense"
base="http://${CENTRAL_BIND_ADDR}:8108"

delete_collection() {
  curl -fsS --max-time 10 \
    -X DELETE \
    -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
    "${base}/collections/${collection}" >/dev/null 2>&1 || true
}
trap delete_collection EXIT

smoke_log "checking Typesense health"
http_ok "${base}/health"

smoke_log "creating temp collection ${collection}"
create_payload="$(jq -n --arg name "$collection" '{name:$name, fields:[{name:"id", type:"string"},{name:"text", type:"string"}]}')"
curl -fsS --max-time 10 \
  -X POST \
  -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data-binary "$create_payload" \
  "${base}/collections" >/dev/null

smoke_log "indexing temp document"
doc_payload="$(jq -n --arg id "doc-1" --arg text "flagggate5 smoke needle" '{id:$id, text:$text}')"
curl -fsS --max-time 10 \
  -X POST \
  -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data-binary "$doc_payload" \
  "${base}/collections/${collection}/documents" >/dev/null

smoke_log "searching temp collection"
search_out="$(curl -fsS --max-time 10 \
  -G "${base}/collections/${collection}/documents/search" \
  -H "X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}" \
  --data-urlencode 'q=flagggate5' \
  --data-urlencode 'query_by=text')"

hits="$(jq -r '.found' <<<"$search_out")"
[[ "$hits" == "1" ]] || fail "Typesense search expected 1 hit, got ${hits}"

smoke_log "ok typesense temp collection import/search/delete"
