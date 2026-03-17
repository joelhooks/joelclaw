# docs-api

Typesense-backed docs REST API for joelclaw.

## Routes

- `GET /health`
- `GET /search?q=<query>[&page=1][&perPage=10][&semantic=true|false][&concept=<id>][&concepts=<id1>,<id2>][&doc_id=<id>][&expand=true|false][&assemble=true|false]`
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

## Run

```bash
pnpm --filter docs-api dev
```
