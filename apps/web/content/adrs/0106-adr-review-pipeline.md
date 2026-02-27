---
number: "106"
title: Content Review Pipeline — Inline Feedback & Agent Update Loop
status: accepted
date: 2026-02-22
updated: 2026-02-27
tags: [content, review, feedback, convex, inngest, ui, cache-components, gremlin]
---

# ADR-0106: Content Review Pipeline — Inline Feedback & Agent Update Loop

## Status

accepted

## Context

joelclaw.com has an inline feedback form on articles. Submitting it does nothing — the form exists but triggers no work. Joel wants: submit feedback → agent ingests it → article updates automatically → live status UI while it's cooking.

This pattern must be **generalized** — not just for joelclaw.com but portable to `badass-courses/gremlin` (the Convex-powered course platform). Both systems share the ContentResource pattern (ADR-0084) and Convex as the real-time data layer (ADR-0039).

### What Changed Since Original Proposal

- Original scope was ADR-specific paragraph-level comments. New scope: **all content types** — articles, ADRs, discoveries, and eventually course content in gremlin.
- The feedback model shifts from paragraph-level threading to **document-level review submissions** — simpler, matches the existing form UX.
- Next.js 16 cache components (PPR) are now stable — the static shell + dynamic slot pattern is the rendering architecture.
- Convex is already deployed in k8s (ADR-0039, shipped). ContentResource schema (ADR-0084, shipped) provides the polymorphic data layer.

## Decision

### Architecture

```
[Reader submits feedback]
       ↓
[Convex mutation: create feedbackItem]
       ↓
[Convex action: fire Inngest event content/review.submitted]
       ↓
[Inngest function: content-review-apply]
  1. Read current content from Convex (ContentResource)
  2. Read all pending feedback for this resource
  3. Spawn agent (pi -p) with content + feedback
  4. Agent produces updated content
  5. Write updated content back to Convex (new revision)
  6. Mark feedback items as resolved
  7. Invalidate cache tag for this resource
  8. Notify via gateway (Telegram/Discord)
       ↓
[Next.js revalidateTag → static shell re-renders cached slot]
```

### Data Model (Convex)

```ts
// Feedback items — separate table, not ContentResource
// (feedback is metadata ABOUT content, not content itself)
feedbackItems: defineTable({
  resourceId: v.string(),        // ContentResource resourceId
  content: v.string(),           // feedback text
  status: v.union(
    v.literal("pending"),        // submitted, awaiting processing
    v.literal("processing"),     // agent is working
    v.literal("applied"),        // agent applied changes
    v.literal("dismissed"),      // manually dismissed
  ),
  authorId: v.optional(v.string()),  // better-auth user ID (optional for anon)
  createdAt: v.number(),
  resolvedAt: v.optional(v.number()),
})
  .index("by_resource", ["resourceId"])
  .index("by_resource_status", ["resourceId", "status"])

// Revision history — tracks every agent edit
contentRevisions: defineTable({
  resourceId: v.string(),
  revisionNumber: v.number(),
  content: v.string(),          // full content at this revision
  diff: v.optional(v.string()), // unified diff from previous
  feedbackIds: v.array(v.string()), // feedback items that triggered this revision
  agentModel: v.string(),       // which model did the edit
  createdAt: v.number(),
})
  .index("by_resource", ["resourceId"])
  .index("by_resource_revision", ["resourceId", "revisionNumber"])
```

### Next.js Rendering — Static Shell + Dynamic Slots

Using cache components (PPR) per the `next-cache-components` skill:

```tsx
// app/[slug]/page.tsx — the static shell
export default async function ArticlePage({ params }) {
  const { slug } = await params

  return (
    <article>
      {/* CACHED: article content, rarely changes */}
      <Suspense fallback={<ArticleSkeleton />}>
        <ArticleContent slug={slug} />
      </Suspense>

      {/* DYNAMIC: feedback status, real-time */}
      <Suspense fallback={null}>
        <FeedbackStatus slug={slug} />
      </Suspense>

      {/* CACHED: feedback form, static UI */}
      <FeedbackForm slug={slug} />
    </article>
  )
}

// Cached content with tag-based invalidation
async function ArticleContent({ slug }: { slug: string }) {
  'use cache'
  cacheLife('max')  // deploy-scoped, invalidated by cacheTag
  cacheTag(`article:${slug}`)

  const content = await getContentResource(slug)
  return <MDXRenderer content={content} />
}
```

### Article Locking UI

When feedback is being processed, the article shows a "revision in progress" state:

```tsx
// Dynamic slot — real-time via Convex subscription
function FeedbackStatus({ slug }: { slug: string }) {
  const status = useQuery(api.feedback.getProcessingStatus, { slug })

  if (!status?.isProcessing) return null

  return (
    <div className="fixed bottom-4 right-4 bg-amber-900/90 text-amber-100 px-4 py-3 rounded-lg">
      <div className="flex items-center gap-2">
        <Spinner />
        <span>{status.message}</span>
      </div>
      <div className="text-xs mt-1 opacity-70">
        Started {formatRelative(status.startedAt)}
      </div>
    </div>
  )
}
```

### Inngest Function

```ts
// content/review.submitted
export const contentReviewApply = inngest.createFunction(
  {
    id: "content-review-apply",
    concurrency: [{ scope: "fn", key: "event.data.resourceId", limit: 1 }],
  },
  { event: "content/review.submitted" },
  async ({ event, step }) => {
    const { resourceId } = event.data

    // 1. Lock: mark all pending feedback as processing
    await step.run("lock-feedback", async () => {
      await convex.mutation(api.feedback.markProcessing, { resourceId })
    })

    // 2. Read content + feedback
    const context = await step.run("read-context", async () => {
      const content = await convex.query(api.content.getByResourceId, { resourceId })
      const feedback = await convex.query(api.feedback.getPending, { resourceId })
      return { content, feedback }
    })

    // 3. Agent edit
    const updated = await step.run("agent-edit", async () => {
      return infer({
        systemPrompt: "You are editing an article based on reader feedback...",
        prompt: `Current content:\n${context.content}\n\nFeedback:\n${context.feedback.map(f => f.content).join('\n')}`,
        model: "claude-sonnet-4-20250514",
      })
    })

    // 4. Write revision
    await step.run("write-revision", async () => {
      await convex.mutation(api.content.createRevision, {
        resourceId,
        content: updated,
        feedbackIds: context.feedback.map(f => f._id),
      })
    })

    // 5. Resolve feedback
    await step.run("resolve-feedback", async () => {
      await convex.mutation(api.feedback.markApplied, { resourceId })
    })

    // 6. Invalidate cache
    await step.run("invalidate-cache", async () => {
      // Next.js on-demand revalidation via route handler
      await fetch(`${SITE_URL}/api/revalidate?tag=article:${resourceId}`)
    })

    // 7. Notify
    await step.run("notify", async () => {
      gateway.notify(`Article updated from feedback: ${resourceId}`)
    })
  }
)
```

### Gremlin Portability

This system is designed for extraction to `@gremlincms/feedback` or similar:

- **Convex schema** is generic (feedbackItems + contentRevisions reference resourceId, not article-specific fields)
- **Inngest function** depends only on the infer utility and Convex client — both available in gremlin
- **UI components** (FeedbackForm, FeedbackStatus, locking indicator) are framework-agnostic React
- **Cache invalidation** uses Next.js `cacheTag` — TanStack Start equivalent TBD for gremlin-cms

The gremlin ADR should be written once this is proven on joelclaw.com.

## Consequences

**Good:**
- Feedback form actually does something — closes the loop
- Article content stays fully static until feedback triggers a revision
- Revision history is first-class — every change tracked with diff and source feedback
- Locking UI prevents confusion during processing
- Pattern is portable to any Convex + Inngest system

**Bad:**
- Content must migrate from filesystem MDX to Convex ContentResource (breaking change for the build pipeline)
- Agent edits are opaque until applied — no preview/approval step (git history is safety net)
- Real-time FeedbackStatus requires Convex client-side provider (small JS bundle cost)

**Mitigations:**
- Filesystem MDX can coexist during migration — new articles in Convex, old ones migrated incrementally
- Revision history + diffs provide post-hoc auditability
- FeedbackStatus component is lazy-loaded, zero cost when no feedback is processing

## Related

- **ADR-0039**: Self-host Convex (shipped — infrastructure exists)
- **ADR-0084**: Unified ContentResource schema (shipped — data model exists)
- **ADR-0075**: Better Auth + Convex (accepted — auth layer)
- **ADR-0112**: Unified caching layer
- **ADR-0149**: Self-hosted Convex evaluation (researching)
- **Gremlin ADR-010**: Convex-first provider/adapter pattern
