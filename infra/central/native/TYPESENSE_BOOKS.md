# Typesense book node

The book node keeps the large vector index out of the operational Typesense process.

- Operational node: `127.0.0.1:8108`
- Book node: `127.0.0.1:8110`
- Collections: `docs`, `docs_chunks_v2`
- LaunchAgent: `com.joelclaw.typesense-books`
- Data: `~/.joelclaw/typesense-books/data`
- Config: `~/.config/joelclaw/typesense-books.ini`

Install or update it on Flagg:

```bash
infra/central/native/install-typesense-books.sh
curl -fsS http://127.0.0.1:8110/health
```

The installer reads the existing Central Typesense key without printing it. It validates the
binary and generated plist before changing the live files. It then starts the node and checks both
the loopback and private tailnet health routes. Only after those checks pass does it write
`DOCS_TYPESENSE_URL=http://127.0.0.1:8110` to `~/.config/system-bus.env`. A failed install restores
the prior files and prior launchd state.

Set `TYPESENSE_BOOKS_TAILNET_HEALTH_URL` to override the private route. The installer requires this
route to pass before it publishes local routing. Configure the private TCP forward first.

Use `scripts/typesense-restore/restore-jsonl.py` for migration. The importer creates the collection
from an exported schema, imports bounded batches, and saves a checkpoint after each batch. Do not
copy a live Typesense data directory.

Route every reader and writer before removing either book collection from the operational node.
The CLI splits unified search into parallel requests when `DOCS_TYPESENSE_URL` differs from
`TYPESENSE_URL`.

The tailnet TCP forward for port `8110` is private. Do not add the book node to Funnel.
