# joelclaw Web (`apps/web`)

Next.js 16 App Router site for `joelclaw.com`.

## Agent-oriented surfaces

- Human HTML pages: route `page.tsx` trees under `apps/web/app/`
- Markdown exports: `https://joelclaw.com/{slug}.md` (rewritten to `app/[slug]/md/route.ts`) and `https://joelclaw.com/sitemap.md`
- API discovery + machine endpoints: `https://joelclaw.com/api`, `https://joelclaw.com/api/search`, `https://joelclaw.com/api/pi-mono`, `https://joelclaw.com/api/docs`, `https://joelclaw.com/feed.xml`, `https://joelclaw.com/llms.txt`

## Public pi-mono corpus surface

- `apps/web/app/api/pi-mono/route.ts` is the discovery endpoint for the public `pi_mono_artifacts` corpus.
- `apps/web/app/api/search/route.ts` now accepts `collection=pi_mono_artifacts` on the public, Upstash-rate-limited search surface.
- The discovery payload at `/api/pi-mono` includes:
  - corpus/search usage examples for `pi_mono_artifacts`
  - current install steps for the `contributing-to-pi` skill
  - honest status for the planned public extension repo `joelhooks/contributing-to-pi-mono`
- Public search returns external GitHub URLs directly for pi-mono artifacts, so top-result next actions can point straight at the source issue/PR/comment/commit/release.

## `/cool` content routing

- `apps/web/app/cool/[slug]/page.tsx` resolves **tutorial posts first** at Convex slug `cool/<slug>`.
- If no tutorial exists for that slug, the route falls back to the legacy `discovery:<slug>` record.
- This keeps `/cool/...` tutorial URLs working even when an older discovery stub still exists for the same topic.

## CLAWMAIL view-source convention

Regular HTML pages include a deterministic head marker script labeled `CLAWMAIL` from the root shell:

- Component: `apps/web/components/clawmail-source-comment.tsx`
- Mounted in: `apps/web/app/layout.tsx`
- Placement: first explicit child inside `<head>` in `app/layout.tsx` (before JSON-LD script)
- Marker form: `<script id="clawmail-agent-prompt" type="text/plain">...</script>`

The marker is intended for agents using **View Source** and includes:

1. A start path (`https://joelclaw.com/sitemap.md`) for route and markdown endpoint discovery
2. API discovery instructions (`https://joelclaw.com/api` → `https://joelclaw.com/api/search` and `https://joelclaw.com/api/docs`)
3. Markdown endpoint instructions (`https://joelclaw.com/{slug}.md`) with `Accept: text/markdown`
4. Plain-text hint endpoint instructions (`https://joelclaw.com/llms.txt`) with `Accept: text/plain`
5. Explicit `Content-Type` verification requirements for markdown/plain/json responses
6. A wrong-endpoint guard (`Content-Type: text/html` means fallback HTML / wrong route)
7. A concise claw-themed ASCII art header at the top of the marker payload for quick human scanning in raw source

Required content-type checks called out in the marker:

- `GET https://joelclaw.com/sitemap.md` with `Accept: text/markdown, text/plain;q=0.9` → expect `Content-Type` starting with `text/markdown` (`text/markdown; charset=utf-8`)
- `GET https://joelclaw.com/{slug}.md` with `Accept: text/markdown` → expect `Content-Type` starting with `text/markdown` (`text/markdown; charset=utf-8`)
- `GET https://joelclaw.com/llms.txt` with `Accept: text/plain` → expect `Content-Type` starting with `text/plain` (`text/plain; charset=utf-8`)
- `GET https://joelclaw.com/api` (and `/api/search`, `/api/docs`) with `Accept: application/json` → expect `Content-Type` starting with `application/json`
- If response `Content-Type` is `text/html`, treat it as fallback/wrong route and retry with the correct endpoint + `Accept` header.

This convention is intentionally scoped to the HTML layout only. Markdown/text route handlers (for example `https://joelclaw.com/sitemap.md`, `https://joelclaw.com/{slug}.md`, `https://joelclaw.com/llms.txt`, and API routes) are not wrapped by the layout and do not inject the CLAWMAIL head marker.
