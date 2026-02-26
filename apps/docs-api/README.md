# docs-api

Typesense-backed docs REST API for joelclaw.

## Routes

- `GET /health`
- `GET /search?q=<query>[&limit=10][&semantic=true|false]`
- `GET /docs[?page=1][&limit=20]`
- `GET /docs/:id`
- `GET /chunks/:id`

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
