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

The comment is intended for agents using **View Source** and includes:

1. Site context
2. `/sitemap.md` discovery guidance
3. `/api` discovery hint
4. Markdown/plain extraction hint (`.md` endpoints and plain-text guidance)

This convention is intentionally scoped to the HTML layout only. Markdown/text route handlers (for example `/sitemap.md`, `/{slug}.md`, `/llms.txt`, and API routes) are not wrapped by the layout and do not inject the HTML source marker.
