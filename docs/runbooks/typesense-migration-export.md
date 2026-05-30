# Typesense Migration Export Runbook

Use this when Panda is being replaced or rebuilt and Typesense data must move first.

## What matters

Typesense is the durable local search/data store for joelclaw. A migration export must include:

- collection schemas
- aliases
- per-collection synonyms and overrides
- all documents as JSONL
- a manifest with counts and SHA-256 checksums

The portable export tool is:

```bash
~/Code/joelhooks/joelclaw/scripts/typesense-export-all.py
```

It writes:

```text
schemas/collections.json
schemas/<collection>.schema.json
documents/<collection>.jsonl.gz
synonyms/<collection>.json
overrides/<collection>.json
aliases.json
manifest.json
```

## Export

Lease the Typesense key without printing it:

```bash
OUT="$HOME/.local/share/typesense-exports/$(date -u +%Y%m%dT%H%M%SZ)-migration"
cd ~/Code/joelhooks/joelclaw
TYPESENSE_API_KEY="$(secrets lease typesense_api_key --ttl 2h --client-id typesense-migration-export)" \
  scripts/typesense-export-all.py --out "$OUT"
tar -C "$(dirname "$OUT")" -czf "${OUT}.tar.gz" "$(basename "$OUT")"
shasum -a 256 "${OUT}.tar.gz" > "${OUT}.tar.gz.sha256"
```

For a schema-only smoke test:

```bash
TYPESENSE_API_KEY="$(secrets lease typesense_api_key --ttl 30m --client-id typesense-export-smoke)" \
  scripts/typesense-export-all.py --skip-documents --out /tmp/typesense-export-smoke
```

## Verify

```bash
tar -tzf "${OUT}.tar.gz" >/dev/null
python3 - "$OUT" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text())
print("collections", manifest["collectionCount"])
print("documents", sum((c.get("documents") or {}).get("documentsExported", 0) for c in manifest["collections"]))
for c in manifest["collections"]:
    exported = (c.get("documents") or {}).get("documentsExported")
    schema = c.get("schemaNumDocuments")
    if exported != schema:
        print("live-write-delta", c["name"], "schema", schema, "exported", exported, "delta", exported - schema)
PY
```

A small delta in high-churn collections like `otel_events` means writes happened while the live export was running. If an exact cut is required, pause writers first: gateway/system-bus/other OTEL emitters. For most machine migrations, the JSONL export is the portable source of truth and a tiny OTEL delta is acceptable.

## Latest Panda export

Created 2026-05-30 after the reboot recovery:

```text
/Users/joel/.local/share/typesense-exports/20260530T224230Z-post-reboot-migration.tar.gz
/Users/joel/.local/share/typesense-exports/20260530T224230Z-post-reboot-migration.tar.gz.sha256
```

Checksum:

```text
085fa65fad4c3d890000719db51a67254dcce7597f917733e7da94d567bb6579
```

Contents:

- 22 collections
- 2,342,320 exported documents
- 1.4 GiB compressed bundle

Known live-write delta: `otel_events` exported 17 more rows than the schema count captured at export start.

## Pull from receiving machine

```bash
DEST="$HOME/typesense-migration"
BUNDLE="20260530T224230Z-post-reboot-migration.tar.gz"
EXPECTED_SHA="085fa65fad4c3d890000719db51a67254dcce7597f917733e7da94d567bb6579"
mkdir -p "$DEST"
rsync -avP --partial --append-verify \
  "joel@panda:/Users/joel/.local/share/typesense-exports/${BUNDLE}" \
  "joel@panda:/Users/joel/.local/share/typesense-exports/${BUNDLE}.sha256" \
  "$DEST/"
cd "$DEST"
test "$(shasum -a 256 "$BUNDLE" | awk '{print $1}')" = "$EXPECTED_SHA"
tar -xzf "$BUNDLE"
```

Do not import on the receiver until the target Typesense version and restore strategy are confirmed.
