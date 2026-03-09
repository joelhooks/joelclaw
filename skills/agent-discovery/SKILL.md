---
name: agent-discovery
displayName: Agent Discovery
description: "Optimize websites, docs, and product surfaces for agent discoverability and operator UX. Use when working on agent SEO/AEO/GEO, crawl policy, markdown or JSON projections, llms.txt, sitemap.md, AGENTS.md guidance, content negotiation, accessibility for browser agents, or any request to make a site easier for pi, OpenCode, Claude Code, ChatGPT, Perplexity, or other agent harnesses to find and use."
version: 0.1.0
author: Joel Hooks
tags: [web, agents, seo, aeo, ux, content]
---

# Agent Discovery

This skill is about an opinionated blend of **traditional SEO**, **static truth in the initial response**, and **UX ergonomics for agents and operators**.

Don't reduce this to "AI SEO".

If a page can't be crawled, cited, parsed, navigated, or actioned by an agent harness, it is broken in a way normal SEO reports won't fully show.

## Thesis

Treat agent discoverability as four stacked layers:

1. **Search baseline** — crawlable pages, clean robots policy, sitemap, structured data, canonical answers, freshness.
2. **Initial-response truth** — the important facts must be present in the first HTML response.
3. **Machine-readable projections** — markdown/text/JSON surfaces that project the same canonical resource without drift.
4. **Operator ergonomics** — the site should be easy to drive from pi, OpenCode, Claude Code, ChatGPT, or a browser agent without guesswork.

If layer 1 is broken, you won't get found.
If layer 2 is broken, agents won't extract the truth.
If layer 3 is broken, harnesses waste tokens scraping HTML.
If layer 4 is broken, operators and browser agents hit dead ends.

## When to Use

Use this skill when the task mentions:

- agent SEO / AEO / GEO / LLM SEO / AAIO
- agent discoverability
- optimize site for ChatGPT / Claude / Perplexity / Copilot
- llms.txt / sitemap.md / markdown endpoints / content negotiation
- AGENTS.md / coding-agent docs / operator docs
- agent-friendly docs / machine-readable docs
- browser-agent UX / agent automation / accessible automation
- making a website easier for agent harnesses to use

## Core Rules

### 1. Do the boring SEO work first

Before fancy protocols, verify:

- `robots.txt` allows the crawlers you actually want
- sitemap exists and stays current
- pages that should never rank use `noindex`
- titles, descriptions, H1s, and headings agree on the topic
- JSON-LD matches visible content exactly
- author/date/source signals are visible where trust matters
- stale pages get refreshed, redirected, or archived

Useful mental model from the audit side:

1. crawlability and indexation
2. technical foundations
3. on-page clarity
4. content quality / trust
5. authority / citations / mentions

### 2. Initial HTML is the truth surface

The important facts must survive:

- `curl`
- a text browser
- no-JS mode
- cheap retrieval pipelines

Don't hide core facts behind:

- client-only fetches
- tabs and accordions with empty initial HTML
- modal-only disclosures
- images or PDFs with no HTML equivalent
- click handlers on `div`s pretending to be controls

Static rendering is a principle, not a framework fetish.

A static shell with small dynamic holes is fine.
A blank SPA shell is dogshit for both search and agents.

### 3. One resource, multiple truthful projections

Give the same resource multiple machine-friendly shapes:

- human page → `text/html`
- markdown twin or negotiated markdown → `text/markdown`
- API / structured route → `application/json`
- text hint surface (`llms.txt`, index text) → `text/plain`

The rule is **projection, not duplication**.

Do not maintain three separate truths for HTML, markdown, and JSON.
Project them from one canonical content source.

### 4. `llms.txt` is a hint surface, not a ranking hack

Use `llms.txt` or similar text hints as:

- a fast discovery point
- a cheap orientation surface
- a pointer to better machine-readable endpoints

Do **not** claim it boosts ranking by itself.
Google has been explicit: AI discovery does not require special AI-only markup.

### 5. AGENTS.md beats hoping skills trigger

For coding-agent surfaces, persistent repo context matters more than wishful tool invocation.

Vercel's evals are useful here:

- skills alone underperformed for general framework guidance
- explicit instructions improved triggering, but wording was fragile
- compressed `AGENTS.md` / repo-instruction context won for broad, always-on guidance

Use:

- **AGENTS.md** for persistent repo rules, paths, commands, retrieval hints
- **skills** for vertical, action-specific workflows

That split matters for pi, OpenCode, and Claude Code.

### 6. Accessibility is agent UX

Browser agents and automation stacks lean on the accessibility tree.

Prefer:

- real `<a>` links with `href`
- real `<button>` elements
- labels on form controls
- `autocomplete` where data entry matters
- proper landmarks and heading hierarchy
- explicit UI state (`aria-expanded`, `role=status`, `aria-live`)

If Playwright can't find it by role or label, an agent harness will likely struggle too.

### 7. Operator UX matters too

An operator using an agent harness should not need to reverse-engineer your product.

Good patterns:

- stable, guessable URLs
- obvious markdown twins or negotiated markdown
- copyable commands and prompts
- JSON responses that advertise next steps (`next_actions` / affordances)
- machine-readable discovery routes (`/api`, `/sitemap.md`, etc.)
- deterministic MIME types

Bad patterns:

- opaque blobs of JSON with no next move
- downloadable markdown buried behind UI chrome
- hidden routes that only work if you already know them
- HTML fallback pretending to be markdown
- "click around and figure it out" operator flows

## joelclaw Implementation Map

When you need concrete evidence, start here.

### Crawl + discovery surfaces

- `apps/web/app/robots.ts`
  - allows crawl globally and advertises both XML and markdown sitemaps
- `apps/web/app/sitemap.md/route.ts`
  - markdown discovery index with posts, ADRs, feeds, and `.md` twins
- `apps/web/app/llms.txt/route.ts`
  - plain-text hint surface pointing agents to `sitemap.md`, `feed.xml`, and markdown access

### Markdown projections

- `apps/web/proxy.ts`
  - canonicalizes `/{slug}.md` and rewrites to the markdown route handler
- `apps/web/app/[slug]/md/route.ts`
  - renders real `text/markdown; charset=utf-8`
  - prepends agent context
  - rewrites internal links to other `.md` twins

### Structured discovery + navigation

- `apps/web/app/api/route.ts`
  - API discovery endpoint with `nextActions`
- `apps/web/app/api/search/route.ts`
  - HATEOAS JSON search envelope with markdown snippets
- `apps/web/components/clawmail-source-comment.tsx`
  - source-visible navigation prompt telling agents which endpoints to hit and what MIME types to verify

### Trust + rendering truth

- `apps/web/app/[slug]/page.tsx`
  - cached article shell, JSON-LD injection, visible metadata, copy-for-agent affordance
- `apps/web/lib/jsonld.ts`
  - BlogPosting / Blog / Person / BreadcrumbList helpers
- `apps/web/lib/posts.ts`
  - Convex-canonical content reads; HTML/markdown projections come from one source
- `apps/web/components/copy-as-prompt.tsx`
  - operator-facing affordance to grab a prompt directly into a harness

### Static rendering example, not doctrine

- `apps/web/next.config.ts`
  - `cacheComponents: true`
- `apps/web/app/[slug]/page.tsx`
  - `'use cache'`, `cacheLife`, `cacheTag` for fast static shells with truthful invalidation

Use those as examples of the principle:

- cached shell
- canonical source
- small dynamic seams
- honest machine projections

Not as a claim that Next.js is the only valid way.

## Verification Checklist

### Crawl + indexing

```bash
curl -s https://example.com/robots.txt
curl -I -A 'OAI-SearchBot/1.3' https://example.com/
curl -I -A 'Googlebot' https://example.com/
```

Check Search Console and Bing Webmaster Tools too.

### Initial-response truth

```bash
curl -sL https://example.com/page | rg -n 'important fact|<h1>|<table>|application/ld\+json'
lynx -dump https://example.com/page
```

If `curl` cannot see the fact, many agents will not either.

### Markdown / text / JSON projections

```bash
curl -I https://example.com/sitemap.md
curl -I https://example.com/page.md
curl -sS https://example.com/api | jq
```

Verify exact MIME types:

- `text/markdown; charset=utf-8`
- `text/plain; charset=utf-8`
- `application/json; charset=utf-8`

If a markdown route returns `text/html`, treat it as broken.

### Accessibility and browser-agent UX

- run Lighthouse / axe
- inspect the accessibility tree
- write Playwright tests with `getByRole` / `getByLabel`
- smoke the key flows with a browser agent, not just curl

### Measurement

Track:

- AI referrers
- citation presence for core queries
- community mentions / repeated phrasing in the wild
- crawl success by user-agent
- content refresh cadence (30 / 90 / 180 day review works fine)

## Anti-Patterns

- Over-indexing on framework-specific tricks instead of content truth
- Claiming `llms.txt` is the magic ranking lever
- Shipping agent protocols on top of broken crawlability
- Maintaining separate truths for HTML, markdown, and JSON
- Returning raw JSON with no next move
- Hiding important facts behind client-side interactivity
- Assuming accessibility is unrelated to agent automation
- Treating MCP as a substitute for honest routes and MIME types

## Use This Mental Shortcut

Ask four questions:

1. **Can an indexer find it?**
2. **Can a retriever extract the truth from the first response?**
3. **Can a harness get a cheaper markdown/JSON version without scraping?**
4. **Can an operator or browser agent actually drive the flow without guessing?**

If any answer is no, fix that first.

That's the work.