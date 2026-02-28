---
number: "168"
title: Convex-Canonical Content Lifecycle (No Repo MDX Sources)
status: accepted
date: 2026-02-28
tags: [content, convex, publishing, durability, observability]
related:
  - "ADR-0084: Unified ContentResource schema"
  - "ADR-0106: ADR Review Pipeline"
  - "ADR-0112: Unified caching layer"
  - "ADR-0154: Content migration MDX to Convex"
---

# ADR-0168: Convex-Canonical Content Lifecycle (No Repo MDX Sources)

## Status

implementing — phase 1 shipped 2026-02-28

## Context

The drafting → publishing → feedback → update → publish loop regressed in production.

Observed failure modes:
- feedback was accepted and marked applied; a later review run rewrote the same resource, silently reverting edits
- mixed authority between filesystem content and Convex content
- whole-document rewrites without regression guards against prior accepted feedback
- cache invalidation and deployment timing can hide stale output long enough to look like successful publish
- new ADRs written to Vault were invisible on the live site because content-sync committed to git but never pushed to Convex (the only production read path)

Root cause: **two sources of truth** — Vault files and Convex records — with no guaranteed sync between them.

## Decision

### 1) Vault is write-side, Convex is read-side

```
Vault (author/edit) → content-sync (Inngest) → Convex (production reads)
                                               → Typesense (search index)
```

For all runtime content classes, source of truth is Convex `contentResources`:
- `article:*`
- `adr:*`
- `discovery:*`

Vault (`~/Vault/docs/decisions/`, `~/Vault/Resources/`) is the canonical authoring surface. Authors edit markdown there. The pipeline reads Vault directly and upserts to Convex — no intermediate repo copy.

### 2) No content files in the repo

`apps/web/content/` retains an empty skeleton with a README explaining content lives in Convex. No markdown/MDX files committed. The content-sync pipeline no longer copies files to the repo, commits, or pushes.

### 3) Durable write contract

Every update/write must include a baseline guard (hash or revision ID) and reject stale writes.
No blind overwrite of content that has moved since read.

### 4) Feedback application must preserve prior accepted intent

`content-review-apply` must include prior resolved/applied feedback context and fail if a rewrite regresses previously accepted replacement assertions unless explicitly reversed by new feedback.

### 5) Publish is immediate and observable

Publish/update action must:
- persist content + revision metadata in Convex
- emit structured telemetry (`resourceId`, `contentSlug`, `contentHashBefore`, `contentHashAfter`, `revisionResourceId`, `runId`)
- revalidate both tags and paths immediately

Required post revalidation targets:
- tags: `post:<slug>`, `article:<slug>`, `articles`
- paths: `/`, `/<slug>`, `/feed.xml`

### 6) CLI seeding and verification

- `joelclaw content seed` — fires `content/seed.requested`, full Vault→Convex sync via Inngest
- `joelclaw content verify` — fires `content/verify.requested`, diffs Vault file list vs Convex records, reports gaps

## Consequences

### Good

- Single source of truth removes file-vs-database drift bugs
- Feedback durability becomes enforceable
- Faster incident forensics through revision/hash lineage
- Predictable publish semantics

### Tradeoffs

- Convex becomes hard dependency for content runtime
- Migration work required for ADR/discovery readers currently on filesystem
- Stricter write guards can produce explicit failures until all callers are updated

## Implementation Plan

### Phase 1 — Convex sync wired in (✅ shipped 2026-02-28)
1. ✅ Created `packages/system-bus/src/lib/convex-content-sync.ts` — shared upsert logic for ADRs and posts
2. ✅ Added `sync-to-convex` step to content-sync Inngest function (upserts changed files after vault sync)
3. ✅ Added `gray-matter` dependency to system-bus
4. ✅ Manual full seed: 175 ADRs + 21 posts synced to Convex

### Phase 2 — Remove repo content, simplify pipeline
5. Rewrite `content-sync.ts` to go Vault→Convex directly (drop file copy, git commit/push, safety review steps)
6. Clean `apps/web/content/` — delete committed markdown files, add README, gitignore
7. Remove filesystem fallback code from `apps/web/lib/adrs.ts` and post readers
8. Add `joelclaw content seed` and `joelclaw content verify` CLI commands

### Phase 3 — Write durability
9. Add baseline-precondition mutation contract (hash/revision guard) to `contentIngest.upsertContent`
10. Ship anti-regression guardrails in `content-review-apply`

### Phase 4 — Observability
11. Publish flow emits revalidation success/failure telemetry with resource identifiers
12. Seed/verify commands emit OTEL events

## Verification

- [x] Convex sync step runs as part of content-sync pipeline
- [x] Full seed populates all Vault content in Convex
- [ ] content-sync reads Vault directly, no repo file copy
- [ ] `apps/web/content/` contains no markdown files
- [ ] Previously applied edits cannot regress via subsequent review runs without explicit reversal feedback
- [ ] Stale-write attempts fail closed with telemetry
- [ ] Articles/ADRs/discoveries render from Convex-only runtime path
- [ ] Publish flow emits revalidation success/failure telemetry with resource identifiers
- [ ] No runtime content reads from `apps/web/content/**`
- [ ] `joelclaw content seed` and `joelclaw content verify` work end-to-end

## Related

- ADR-0084 Unified ContentResource schema
- ADR-0106 ADR Review Pipeline
- ADR-0112 Unified caching layer
- ADR-0154 Content migration MDX to Convex
