---
number: "154"
title: Article Content Migration — MDX to Convex ContentResource
status: proposed
date: 2026-02-27
tags: [content, convex, migration, mdx, cache-components, articles]
related:
  - "ADR-0039: Self-host Convex"
  - "ADR-0084: Unified ContentResource schema"
  - "ADR-0106: Content Review Pipeline"
  - "ADR-0075: Better Auth + Convex"
---

# ADR-0154: Article Content Migration — MDX to Convex ContentResource

## Status

proposed

## Context

joelclaw.com articles live as `.mdx` files in `apps/web/content/`. The content review pipeline (ADR-0106) needs articles in Convex so agents can read, edit, and write revisions. The feedback form on joelclaw.com currently triggers no work — this migration enables closing that loop.

Auth is shipped. Convex is deployed in k8s (ADR-0039). ContentResource schema exists (ADR-0084). The missing piece is getting article content into Convex and wiring the rendering pipeline to read from it.

### Decisions Made

- **Convex is source of truth** — filesystem MDX becomes seed input only, not read at runtime
- **Feedback is Joel-only** — auth-gated, single user
- **Agent edits auto-publish** — no approval step, revision history provides safety net
- **Raw MDX stored in Convex** — preserves component imports and JSX

## Decision

### Phase 1: Seed Script

A one-shot script reads all `.mdx` files from `apps/web/content/`, parses frontmatter, and writes each as a ContentResource:

```ts
// scripts/seed-articles.ts
import { ConvexHttpClient } from "convex/browser"
import { api } from "../convex/_generated/api"
import fs from "fs"
import path from "path"
import matter from "gray-matter"

const client = new ConvexHttpClient(process.env.CONVEX_URL!)

const contentDir = path.join(process.cwd(), "apps/web/content")
const files = fs.readdirSync(contentDir).filter(f => f.endsWith(".mdx"))

for (const file of files) {
  const raw = fs.readFileSync(path.join(contentDir, file), "utf-8")
  const { data: meta, content } = matter(raw)
  const slug = file.replace(/\.mdx$/, "")

  await client.mutation(api.content.upsert, {
    resourceId: `article:${slug}`,
    type: "article",
    fields: {
      slug,
      title: meta.title,
      description: meta.description,
      content,           // raw MDX body (no frontmatter)
      image: meta.image || null,
      tags: meta.tags || [],
      type: meta.type || "post",
      date: meta.date,
      updated: meta.updated || null,
      draft: meta.draft || false,
    },
  })
  console.log(`Seeded: ${slug}`)
}
```

### Phase 2: Read Path — getPost() from Convex

Replace filesystem reads with Convex queries:

```ts
// apps/web/lib/posts.ts (new)
import { fetchQuery } from "convex/nextjs"
import { api } from "../../convex/_generated/api"

export async function getPost(slug: string): Promise<Post | null> {
  const resource = await fetchQuery(api.content.getByResourceId, {
    resourceId: `article:${slug}`,
  })
  if (!resource || resource.type !== "article") return null

  return {
    meta: {
      slug: resource.fields.slug,
      title: resource.fields.title,
      description: resource.fields.description,
      date: resource.fields.date,
      updated: resource.fields.updated,
      type: resource.fields.type,
      tags: resource.fields.tags,
      image: resource.fields.image,
      draft: resource.fields.draft,
    },
    content: resource.fields.content,
  }
}

export async function getAllPosts(): Promise<PostMeta[]> {
  const resources = await fetchQuery(api.content.listByType, {
    type: "article",
  })
  return resources
    .filter(r => !r.fields.draft)
    .sort((a, b) => new Date(b.fields.date).getTime() - new Date(a.fields.date).getTime())
    .map(r => r.fields as PostMeta)
}
```

### Phase 3: Rendering — Static Shell + Dynamic Slots

```tsx
// app/[slug]/page.tsx
import { Suspense } from "react"

export default async function ArticlePage({ params }) {
  const { slug } = await params

  return (
    <article>
      {/* CACHED: article content */}
      <Suspense fallback={<ArticleSkeleton />}>
        <CachedArticle slug={slug} />
      </Suspense>

      {/* DYNAMIC: feedback status (Convex subscription, client island) */}
      <Suspense fallback={null}>
        <FeedbackStatusIsland slug={slug} />
      </Suspense>

      {/* STATIC: feedback form */}
      <FeedbackForm slug={slug} />
    </article>
  )
}

async function CachedArticle({ slug }: { slug: string }) {
  'use cache'
  cacheLife('max')
  cacheTag(`article:${slug}`)

  const post = await getPost(slug)
  if (!post) notFound()

  return <MDXRenderer source={post.content} />
}
```

### Phase 4: MDX Rendering from String

Currently MDX is compiled at build time via next-mdx-remote or similar. With content from Convex, we need runtime MDX compilation:

```tsx
// components/mdx-renderer.tsx
import { compileMDX } from 'next-mdx-remote/rsc'
import { components } from './mdx-components'

export async function MDXRenderer({ source }: { source: string }) {
  const { content } = await compileMDX({
    source,
    components,
    options: {
      parseFrontmatter: false, // already parsed
    },
  })
  return content
}
```

This runs server-side inside the `'use cache'` boundary — compiled once, cached until tag invalidation.

### Phase 5: Cache Invalidation Endpoint

```ts
// app/api/revalidate/route.ts
import { revalidateTag } from 'next/cache'
import { headers } from 'next/headers'

export async function POST(req: Request) {
  const h = await headers()
  const secret = h.get('x-revalidation-secret')
  if (secret !== process.env.REVALIDATION_SECRET) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { tag } = await req.json()
  revalidateTag(tag)
  return Response.json({ revalidated: true, tag })
}
```

### Phase 6: Wire Feedback Pipeline (ADR-0106)

With content in Convex and cache invalidation working, the feedback form → Inngest → agent → revision → revalidate loop is complete.

### generateStaticParams

```ts
export async function generateStaticParams() {
  // At build time, Convex HTTP client fetches all article slugs
  const client = new ConvexHttpClient(process.env.CONVEX_URL!)
  const articles = await client.query(api.content.listSlugs, { type: "article" })
  return articles.map(slug => ({ slug }))
}
```

This works because `ConvexHttpClient` is a plain HTTP client — no WebSocket, no provider needed.

## Filesystem MDX After Migration

The `.mdx` files in `apps/web/content/` become:
- **Seed source** for initial migration
- **Git history** for article provenance
- **Not read at runtime** — Convex is the live source

New articles are created in Convex directly (via dashboard, API, or agent). The MDX files can stay in the repo as archival artifacts but are not part of the build.

## Consequences

**Good:**
- Articles are writable by agents — enables the entire feedback pipeline
- Static shell with cached content — same performance as current filesystem reads
- `cacheTag` invalidation is surgical — only the edited article re-renders
- `ConvexHttpClient` for build-time queries means no provider complexity at the page level
- Revision history in Convex provides full audit trail

**Bad:**
- Runtime MDX compilation adds ~50-100ms per cache miss (amortized by `cacheLife('max')`)
- Convex becomes a hard dependency for the site (currently zero runtime deps)
- MDX component imports (`import X from './component'`) won't work from Convex strings — only pre-registered components via the components map

**Mitigations:**
- Cache miss cost is acceptable — happens once per deploy or revalidation
- Convex in k8s is on the same machine — sub-ms latency
- All current MDX components are already in a shared components map — no dynamic imports in article content

## Resolved Questions

- **Discoveries**: Yes, but in a later phase. Articles first to prove the pipeline.
- **Seed script**: Idempotent upsert — re-runnable during development and if MDX files update before cutover.
- **Feedback scope**: Joel-only (auth-gated, single user).
- **Agent edits**: Auto-publish, no approval step. Revision history is the safety net.
- **Content format**: Raw MDX in Convex — preserves component imports and JSX.

## Technical Notes

- **`fetchQuery` from `convex/nextjs` sets `cache: "no-store"`** internally. This is fine inside a `'use cache'` boundary — the outer cache directive handles caching. But `fetchQuery` outside a cache boundary hits Convex on every request.
- **`compileMDX` from `next-mdx-remote/rsc`** uses `Function()` constructor to eval compiled MDX. Inside `'use cache'` this works because the output is a serializable React tree. The components map must be passed at compile time, not closed over.
- **`ConvexHttpClient` from `convex/browser`** is correct for `generateStaticParams` and seed scripts — plain HTTP, no WebSocket, no provider. Already used in `apps/web/lib/convex-content.ts` and `packages/system-bus/src/lib/convex.ts`.

## Related

- **ADR-0039**: Self-host Convex (shipped — infrastructure)
- **ADR-0084**: ContentResource schema (shipped — `article` type added)
- **ADR-0106**: Content Review Pipeline (accepted — the consumer of this migration)
- **ADR-0075**: Better Auth (shipped — auth for feedback)
- **ADR-0112**: Unified caching layer
