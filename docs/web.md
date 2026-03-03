# joelclaw Web (`apps/web`)

Next.js 16 App Router site for `joelclaw.com`.

## Agent-oriented surfaces

- Human HTML pages: route `page.tsx` trees under `apps/web/app/`
- Markdown exports: `https://joelclaw.com/{slug}.md` (rewritten to `app/[slug]/md/route.ts`) and `https://joelclaw.com/sitemap.md`
- API discovery + machine endpoints: `https://joelclaw.com/api`, `https://joelclaw.com/api/search`, `https://joelclaw.com/api/docs`, `https://joelclaw.com/feed.xml`, `https://joelclaw.com/llms.txt`

## CLAWMAIL view-source convention

Regular HTML pages include a rendered HTML source comment labeled `CLAWMAIL` from the root shell:

- Component: `apps/web/components/clawmail-source-comment.tsx`
- Mounted in: `apps/web/app/layout.tsx`
- Placement: first explicit child in `<head>` (framework metadata may still render above it), which is the highest stable placement available from the app layout

The comment is intended for agents using **View Source** and includes:

1. A start path (`https://joelclaw.com/sitemap.md`) for route and markdown endpoint discovery
2. API discovery instructions (`https://joelclaw.com/api` → `https://joelclaw.com/api/search` and `https://joelclaw.com/api/docs`)
3. Markdown endpoint instructions (`https://joelclaw.com/{slug}.md`) with `Accept: text/markdown`
4. Plain-text hint endpoint instructions (`https://joelclaw.com/llms.txt`) with `Accept: text/plain`
5. Explicit `Content-Type` verification requirements for markdown/plain/json responses
6. A wrong-endpoint guard (`Content-Type: text/html` means fallback HTML / wrong route)

Required content-type checks called out in the marker:

- `GET https://joelclaw.com/sitemap.md` with `Accept: text/markdown, text/plain;q=0.9` → expect `Content-Type` starting with `text/markdown` (`text/markdown; charset=utf-8`)
- `GET https://joelclaw.com/{slug}.md` with `Accept: text/markdown` → expect `Content-Type` starting with `text/markdown` (`text/markdown; charset=utf-8`)
- `GET https://joelclaw.com/llms.txt` with `Accept: text/plain` → expect `Content-Type` starting with `text/plain` (`text/plain; charset=utf-8`)
- `GET https://joelclaw.com/api` (and `/api/search`, `/api/docs`) with `Accept: application/json` → expect `Content-Type` starting with `application/json`
- If response `Content-Type` is `text/html`, treat it as fallback/wrong route and retry with the correct endpoint + `Accept` header.

This convention is intentionally scoped to the HTML layout only. Markdown/text route handlers (for example `https://joelclaw.com/sitemap.md`, `https://joelclaw.com/{slug}.md`, `https://joelclaw.com/llms.txt`, and API routes) are not wrapped by the layout and do not inject the HTML source marker.
