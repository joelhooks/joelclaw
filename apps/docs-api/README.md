# docs-api

Typesense-backed docs REST API for joelclaw.

## Routes

- `GET /health`
- `GET /status`
- `GET /search?q=<query>[&page=1][&perPage=10][&semantic=true|false][&concept=<id>][&concepts=<id1>,<id2>][&doc_id=<id>][&expand=true|false][&assemble=true|false]`
- `GET /docs/search?q=<query>[&concept=<id>][&page=1][&perPage=20]`
- `GET /docs/:id/toc`
- `GET /docs/:id/chunks[?type=section|snippet][&page=1][&perPage=50]`
- `GET /docs/:id/markdown`
- `GET /docs/:id/summary`
- `GET /docs/:id/artifact/meta`
- `GET /docs[?page=1][&perPage=20]`
- `GET /docs/:id`
- `GET /chunks/:id[?lite=true][&includeEmbedding=false]`
- `GET /concepts`
- `GET /concepts/:id`
- `GET /concepts/:id/docs[?page=1][&perPage=20]`

Also supports optional mounted prefix:
- `/api/docs/*`

## Auth

All routes except `/health` require:

`Authorization: Bearer <PDF_BRAIN_API_TOKEN>`

## Env

- `HOST` (default `0.0.0.0`)
- `PORT` (default `3838`)
- `TYPESENSE_URL` (default `http://typesense:8108`)
- `TYPESENSE_API_KEY` (required)
- `PDF_BRAIN_API_TOKEN` (required)
- `DOCS_CHUNKS_COLLECTION` (default `docs_chunks_v2`)
- `DOCS_ARTIFACTS_DIR` (default `/Volumes/three-body/docs-artifacts`)

## Notes

- The API defaults to the ADR-0234 v2 chunk collection (`docs_chunks_v2`) with `nomic-embed-text-v1.5` embeddings.
- Artifact-backed document reads come from NAS-backed markdown + metadata files in `DOCS_ARTIFACTS_DIR`.

## Run

```bash
pnpm --filter docs-api dev
```
