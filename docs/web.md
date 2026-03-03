# joelclaw Web (`apps/web`)

Next.js 16 App Router site for `joelclaw.com`.

## Agent-oriented surfaces

- Human HTML pages: route `page.tsx` trees under `apps/web/app/`
- Markdown exports: `/{slug}.md` (rewritten to `app/[slug]/md/route.ts`) and `/sitemap.md`
- API discovery + machine endpoints: `/api`, `/api/search`, `/api/docs`, `/feed.xml`, `/llms.txt`

## CLAWMAIL view-source convention

Regular HTML pages include a rendered HTML source comment labeled `CLAWMAIL` from the root shell:

- Component: `apps/web/components/clawmail-source-comment.tsx`
- Mounted in: `apps/web/app/layout.tsx`
- Placement: first node under `<html>` (before `<head>` and `<body>`) so the marker is at the top of View Source for HTML pages

The comment is intended for agents using **View Source** and includes:

1. A start path (`/sitemap.md`) for route and markdown endpoint discovery
2. API discovery instructions (`/api` → `/api/search` and `/api/docs`)
3. Markdown endpoint instructions (`/{slug}.md`) with `Accept: text/markdown`
4. Plain-text hint endpoint instructions (`/llms.txt`) with `Accept: text/plain`
5. A wrong-endpoint guard (`Content-Type: text/html` means fallback HTML / wrong route)

Required content-type checks called out in the marker:

- `GET /{slug}.md` with `Accept: text/markdown` → verify response `Content-Type` contains `text/markdown`
- `GET /llms.txt` with `Accept: text/plain` → verify response `Content-Type` contains `text/plain`
- If response `Content-Type` is `text/html`, treat it as fallback/wrong route and retry the correct endpoint.

This convention is intentionally scoped to the HTML layout only. Markdown/text route handlers (for example `/sitemap.md`, `/{slug}.md`, `/llms.txt`, and API routes) are not wrapped by the layout and do not inject the HTML source marker.
