---
number: "106"
title: ADR Review Pipeline — Inline Comments & Agent Update Loop
status: proposed
date: 2026-02-22
tags: [adrs, review, comments, convex, inngest, ui]
---

# ADR-0106: ADR Review Pipeline — Inline Comments & Agent Update Loop

## Status

accepted

## Context

ADRs on joelclaw.com are currently read-only. Reviewing one means either editing the file directly (breaks the reading flow) or keeping notes elsewhere and manually reconciling. There's no mobile-friendly way to annotate, no thread model for refining thoughts, and no pipeline to push those annotations back to the agent for ADR updates.

The desired workflow: read an ADR on the phone, tap a paragraph to leave an inline comment, stack multiple comments across sections, refine them, hit "Submit Review" — then let an agent update the ADR and ping when it's ready for another pass.

## Decision

Implement a paragraph-level inline comment system on joelclaw.com, authenticated to Joel only, wired to an Inngest agent loop that applies comments to the ADR source and notifies via Telegram.

### Data Model (Convex)

```ts
// convex/schema.ts addition
adrComments: defineTable({
  adrSlug: v.string(),          // e.g. "0106-adr-review-pipeline"
  paragraphId: v.string(),       // stable ID from rehype transform
  content: v.string(),           // comment text
  threadId: v.string(),          // groups comments on same paragraph
  parentId: v.optional(v.id("adrComments")), // for replies
  status: v.union(
    v.literal("draft"),          // in progress
    v.literal("submitted"),      // sent to agent
    v.literal("resolved"),       // agent applied it
  ),
  authorId: v.string(),          // better-auth user ID
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_adr", ["adrSlug"])
  .index("by_thread", ["threadId"])
  .index("by_adr_status", ["adrSlug", "status"])
```

### Paragraph ID Strategy

A rehype plugin (`rehype-paragraph-ids`) wraps each block-level element (`<p>`, `<h1>`–`<h6>`, `<li>`, `<blockquote>`) with a stable `id` and `data-paragraph-id`. The ID is derived from:

1. Heading text (slugified) for headings
2. Content hash (first 8 chars of SHA-256 of trimmed text) for paragraphs

IDs are deterministic: the same content always produces the same ID, so comment anchors survive whitespace-only edits.

### UI (mobile-first)

**Reading mode (unauthenticated / not logged in):** Normal ADR page, no comment UI.

**Review mode (authenticated):** 
- A thin left-border highlight appears on hover/focus of each commentable block
- Tap/click a block → comment drawer slides up from bottom (bottom sheet on mobile, inline panel on desktop)
- Comment input with markdown support
- Each thread shows comment count badge on the paragraph
- "All Comments" FAB at bottom-right → opens full review sheet showing all draft comments for this ADR, grouped by paragraph
- "Submit Review" button in the review sheet → fires the Inngest event

### Inngest Event

```ts
// Event: adr/review.submitted
{
  name: "adr/review.submitted",
  data: {
    adrSlug: string,
    comments: Array<{
      paragraphId: string,
      paragraphSnippet: string,  // first 80 chars of the paragraph for context
      content: string,
      threadId: string,
    }>,
    submittedBy: string,
  }
}
```

### Agent Loop

`adr/review.submitted` triggers an Inngest function that:

1. Reads the ADR markdown file from `~/Vault/docs/decisions/`
2. Spawns a pi agent (via `codex exec`) with the ADR content + comments as context
3. Agent rewrites the ADR incorporating the review feedback
4. Commits to Vault: `git add -A && git commit -m "adr(0NNN): review pass — N comments applied"`
5. Pushes to origin
6. Fires `vault/adr.changed` event (picked up by ADR-0107 Convex sync)
7. Marks all submitted comments as `resolved` in Convex
8. Sends Telegram notification: "ADR-0NNN updated. N comments applied. [view →]"

## Consequences

**Good:**
- Mobile-first review workflow that doesn't interrupt reading
- Comments are durable (Convex) — survive page refresh, can be resumed
- Agent update is auditable via git history
- Paragraph IDs are content-stable — anchors don't break on minor rewrites
- Threaded model supports back-and-forth without coupling to any one session

**Bad:**
- If paragraph content changes significantly, content-hash IDs break existing comment anchors (orphaned comments)
- Paragraph ID generation adds a build-time rehype step (small complexity)
- Agent rewrite is opaque — no diff shown to Joel before apply (acceptable: git is the safety net)

**Mitigations:**
- Orphaned comments (no matching `data-paragraph-id` in DOM) surface in the review sheet with a warning banner
- Version history (future ADR-0108) will make rewrite history inspectable

## Related

- ADR-0107: ADR Content Migration to Convex (read cache + on-demand revalidation)
- ADR-0018: Gateway event bridge
- ADR-0038: Embedded pi gateway daemon
