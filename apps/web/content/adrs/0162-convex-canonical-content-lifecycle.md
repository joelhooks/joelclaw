---
number: "162"
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

# ADR-0162: Convex-Canonical Content Lifecycle (No Repo MDX Sources)

## Status

accepted

## Context

The drafting → publishing → feedback → update → publish loop regressed in production.

Observed failure mode:
- feedback was accepted and marked applied
- a later review run rewrote the same resource
- earlier accepted edits were silently reverted

Root causes:
- mixed authority between filesystem content and Convex content
- whole-document rewrites without regression guards against prior accepted feedback
- cache invalidation and deployment timing can hide stale output long enough to look like successful publish

## Decision

### 1) Convex is canonical for publishable content

For all runtime content classes, source of truth is Convex `contentResources`:
- `article:*`
- `adr:*`
- `discovery:*`

### 2) No runtime source MD/MDX files in app content paths

`apps/web/content/**` is no longer an authoring source for live runtime reads.
Optional export snapshots are allowed only as backup artifacts outside runtime read paths.

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

1. Ship anti-regression guardrails in `content-review-apply` (historical context + assertion check).
2. Add baseline-precondition mutation contract for content updates.
3. Migrate ADR/discovery read paths from filesystem to Convex in `apps/web/lib/*`.
4. Remove filesystem fallback from runtime content readers.
5. Keep optional backup exports outside runtime source tree.

## Verification

- [ ] Previously applied edits cannot regress via subsequent review runs without explicit reversal feedback.
- [ ] Stale-write attempts fail closed with telemetry.
- [ ] Articles/ADRs/discoveries render from Convex-only runtime path.
- [ ] Publish flow emits revalidation success/failure telemetry with resource identifiers.
- [ ] No runtime content reads from `apps/web/content/**`.

## Related

- ADR-0084 Unified ContentResource schema
- ADR-0106 ADR Review Pipeline
- ADR-0112 Unified caching layer
- ADR-0154 Content migration MDX to Convex
