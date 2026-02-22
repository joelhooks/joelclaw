---
title: Client-Side Search with Pagefind
date: 2026-02-19
status: implemented
---

# ADR-0063: Client-Side Search with Pagefind

## Context and Problem Statement

joelclaw.com has ~80 pages of content (10 articles, 63 ADRs, 7 discoveries) with no search. Users can only browse by section (Writing, Cool, ADRs, Network) or scroll through listings. As the site grows, discoverability degrades — content published months ago becomes invisible.

The site needs client-side full-text search that works without a server component, integrates with the existing dark editorial aesthetic, and adds near-zero bundle cost until the user actually searches.

## Decision Drivers

- **Zero infrastructure** — no Algolia, Elasticsearch, or backend API required
- **Minimal bundle impact** — search JS/WASM should lazy-load only when triggered
- **Works with Vercel + Next.js App Router** — must integrate with the existing build pipeline
- **Indexes all content types** — articles, ADRs, and discoveries
- **Keyboard-first** — ⌘K/Ctrl+K to open, arrow keys to navigate, Enter to select

## Considered Options

1. **Pagefind** — Static search library, indexes rendered HTML at build time, chunked lazy-loading
2. **FlexSearch** — High-performance in-memory full-text search, manual index management
3. **Orama** — TypeScript-first search engine, good DX, requires manual document registration
4. **MiniSearch** — Lightweight client-side search, simple API

## Decision

**Pagefind** — static search library that runs after `next build` and indexes the pre-rendered HTML.

### Why Pagefind over FlexSearch

FlexSearch is the fastest client-side search engine by benchmarks (~50M ops/sec), but the performance advantage is invisible at <100 documents. FlexSearch requires manual index construction, has 75% TypeScript coverage, and uses a dated build toolchain (Babel 6 + Google Closure Compiler). Pagefind auto-indexes rendered HTML with zero configuration.

### Why Pagefind over Orama/MiniSearch

Both require building a search index manually from content data, then serializing and shipping it to the client. Pagefind eliminates this entirely — it reads the pre-rendered HTML, generates a chunked index, and only loads the fragments needed for each query. Total network payload for a 10,000-page site is under 300KB.

## Implementation

### Build Pipeline

Pagefind runs as a postbuild step in `apps/web/package.json`:

```json
"build": "next build && pagefind --site .next/server/app --output-path .next/static/pagefind"
```

- Indexes all `.html` files in `.next/server/app/` (pre-rendered by Next.js)
- Only indexes elements with `data-pagefind-body` (article pages)
- Listing pages (homepage, /adrs, /cool, /network) are excluded automatically
- Output goes to `.next/static/pagefind/` → served at `/_next/static/pagefind/`

### Content Annotation

Article pages use `data-pagefind-body` and `data-pagefind-meta` attributes:

- `apps/web/app/[slug]/page.tsx` — `data-pagefind-meta="type:{postType}"`
- `apps/web/app/adrs/[slug]/page.tsx` — `data-pagefind-meta="type:ADR, status:{status}"`
- `apps/web/app/cool/[slug]/page.tsx` — `data-pagefind-meta="type:discovery"`

### Search UI

Command palette triggered by ⌘K/Ctrl+K:

- `components/search-dialog.tsx` — client component with lazy pagefind loading
- `components/mobile-nav.tsx` — hamburger menu for mobile breakpoints
- Pagefind JS loaded via dynamic import only when search dialog opens
- Results show type badge, title, highlighted excerpt, and URL path
- Keyboard navigation: ↑↓ to move, ↵ to select, Esc to close

### Mobile Navigation

Added responsive hamburger menu (`md:hidden`):

- Desktop: inline nav links + search icon with ⌘K badge
- Mobile: search icon + hamburger → full-screen overlay with nav links

### Affected Paths

- `apps/web/components/search-dialog.tsx` — new
- `apps/web/components/mobile-nav.tsx` — new
- `apps/web/app/layout.tsx` — updated header with search + hamburger
- `apps/web/app/globals.css` — search dialog animations, highlight styles
- `apps/web/app/[slug]/page.tsx` — added pagefind data attributes
- `apps/web/app/adrs/[slug]/page.tsx` — added pagefind data attributes
- `apps/web/app/cool/[slug]/page.tsx` — added pagefind data attributes
- `apps/web/package.json` — added pagefind devDep, updated build script

## Consequences

### Positive

- Search works with zero ongoing infrastructure or API costs
- Pagefind index rebuilds automatically on every deploy
- Bundle cost is ~5KB until search is triggered, then lazy-loads chunks
- Result highlighting uses the site's accent color (#ff1493) for visual consistency
- Mobile users get proper hamburger nav instead of cramped inline links
- All content types (articles, ADRs, discoveries) are searchable with type badges

### Negative

- Search index is only as fresh as the last build — no real-time indexing
- Pagefind indexes rendered HTML, so any layout/template text inside `data-pagefind-body` leaks into the index
- URL normalization required: Next.js pre-renders to `/slug.html` or `/slug/page.html` paths that need stripping

### Neutral

- The existing Qdrant vector search (backend) is unaffected — this is complementary client-side full-text search
- Pagefind's WASM runtime works across all modern browsers

## Verification

- [x] `pnpm build` succeeds with pagefind postbuild step
- [x] Pagefind indexes 79 pages across all content types
- [x] `/_next/static/pagefind/pagefind.js` returns 200 from Next.js server
- [x] Search dialog opens with ⌘K, renders input and results area
- [x] Mobile hamburger menu renders on small screens
- [x] Desktop nav links hidden on mobile, hamburger hidden on desktop
- [x] TypeScript passes (`tsc --noEmit`)

## More Information

- [Pagefind documentation](https://pagefind.app/)
- [Next.js + Pagefind integration guide](https://www.petemillspaugh.com/nextjs-search-with-pagefind)
- Credit: Pete Millspaugh for the Next.js App Router + Pagefind pattern
