# joelclaw Web (`apps/web`)

Next.js 16 App Router site for `joelclaw.com`.

## Agent-oriented surfaces

- Human HTML pages: route `page.tsx` trees under `apps/web/app/`
- Markdown exports: `https://joelclaw.com/{slug}.md` (rewritten to `app/[slug]/md/route.ts`) and `https://joelclaw.com/sitemap.md`
- API discovery + machine endpoints: `https://joelclaw.com/api`, `https://joelclaw.com/api/search`, `https://joelclaw.com/api/pi-mono`, `https://joelclaw.com/api/docs`, `https://joelclaw.com/feed.xml`, `https://joelclaw.com/llms.txt`

## Post-content revalidation contract

Post-like Convex content updates (`article`, `tutorial`, `essay`, `note`) must invalidate **both** the human page and the markdown projection. Revalidating only `/${slug}` is insufficient because the public markdown twin is served from a separate route handler and can stay stale at the edge.

Required tags:
- `post:<slug>`
- `article:<slug>`
- `articles`

Required paths:
- `/`
- `/${slug}`
- `/${slug}.md`
- `/${slug}/md`
- `/feed.xml`
- `/sitemap.md`

## Public pi-mono corpus surface

- `apps/web/app/api/pi-mono/route.ts` is the discovery endpoint for the public `pi_mono_artifacts` corpus.
- `apps/web/app/api/search/route.ts` now accepts `collection=pi_mono_artifacts` on the public, Upstash-rate-limited search surface.
- The discovery payload at `/api/pi-mono` includes:
  - corpus/search usage examples for `pi_mono_artifacts`
  - current install steps for the public `contributing-to-pi-mono` skill
  - current install steps for the public extension repo `joelhooks/contributing-to-pi-mono`
- Public search returns external GitHub URLs directly for pi-mono artifacts, so top-result next actions can point straight at the source issue/PR/comment/commit/release.

## `/cool` content routing

- `apps/web/app/cool/[slug]/page.tsx` resolves **tutorial posts first** at Convex slug `cool/<slug>`.
- If no tutorial exists for that slug, the route falls back to the legacy `discovery:<slug>` record.
- This keeps `/cool/...` tutorial URLs working even when an older discovery stub still exists for the same topic.

## ADR route aliases

- Vault and Convex keep the canonical ADR source slug from the filename, e.g. `0217-event-routing-queue-discipline`.
- Public web routes use the short alias form `/adrs/adr-0217`, derived from the ADR number.
- `apps/web/lib/adrs.ts` resolves `adr-####` (and bare `####`) back to the canonical Convex resource ID, so content sync does **not** need duplicate ADR records.
- `apps/web/app/adrs/[slug]/page.tsx` permanently redirects legacy full-slug ADR URLs to the short alias route while keeping review/live-update lookups pinned to the canonical Convex resource ID.

## Post display rules

- `apps/web/app/[slug]/page.tsx` renders the post title in the page header from Convex metadata.
- The markdown/MDX body must not render a second top-level H1 below that header.
- The post renderer strips a markdown H1 before passing content into `MDXRemote`.
- Regex: `content.replace(/^#\s+.*$/m, "").trim()`

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
