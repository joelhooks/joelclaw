---
number: "107"
title: ADR Content Migration — Filesystem to Convex Read Projection
status: proposed
date: 2026-02-22
tags: [adrs, convex, sync, isr, inngest]
---

# ADR-0107: ADR Content Migration — Filesystem to Convex Read Projection

## Status

proposed

## Context

ADRs are currently read from `~/Vault/docs/decisions/*.md` at build time via `getAdr()` / `getAllAdrs()` in `apps/web/lib/adrs.ts`. The content is statically generated — updating an ADR requires a Vercel redeploy to reflect changes on joelclaw.com.

This creates friction for the agent review loop (ADR-0106): after an agent updates an ADR file and pushes to git, the site won't reflect changes until the next deploy. For a review-and-revise workflow, the feedback cycle needs to be seconds not minutes.

Additionally, the comment system (ADR-0106) lives in Convex. If ADR content also lives in Convex, comments become natural relations rather than dangling slug references.

## Decision

Migrate ADR content from filesystem reads to a Convex read projection. Vault files remain the canonical source. Convex is a derived, query-optimized cache.

### Vault as Source of Truth

No change to the authoring workflow:
- ADRs are written to `~/Vault/docs/decisions/*.md`
- Agent loop writes, commits, and pushes here
- Vault git history is the audit trail

### Convex Schema

```ts
// convex/schema.ts addition
adrs: defineTable({
  slug: v.string(),           // "0106-adr-review-pipeline"
  number: v.string(),         // "106"
  title: v.string(),
  status: v.string(),         // proposed | accepted | shipped | superseded | deprecated | rejected
  date: v.optional(v.string()),
  tags: v.array(v.string()),
  content: v.string(),        // raw markdown (minus title heading)
  frontmatter: v.string(),    // serialized original frontmatter
  supersededBy: v.optional(v.string()),
  syncedAt: v.number(),       // epoch ms of last Vault sync
  contentHash: v.string(),    // SHA-256 of content, used for dedup
})
  .index("by_slug", ["slug"])
  .index("by_status", ["status"])
  .index("by_number", ["number"])
```

### Sync Trigger

**`vault/adr.changed` Inngest event** triggers an upsert:

```ts
// Event payload
{
  name: "vault/adr.changed",
  data: {
    slug: string,
    filePath: string,   // absolute path on panda
    reason: string,     // "agent-review" | "manual-edit" | "bulk-import"
  }
}
```

The Inngest function:
1. Reads the file from `filePath` on the worker host
2. Parses frontmatter + content
3. Computes `contentHash` — skips if unchanged
4. Upserts to Convex via HTTP action
5. Calls `revalidatePath('/adrs/' + slug)` via Next.js on-demand ISR endpoint

### Initial Import

A one-time `joelclaw adr sync` CLI command (or Inngest `adr/bulk.import` event) reads all `~/Vault/docs/decisions/*.md` files and fires `vault/adr.changed` events for each. This bootstraps Convex with the full ADR corpus.

### Next.js Data Layer

Replace filesystem reads with Convex queries:

```ts
// lib/adrs.ts — after migration
import { fetchQuery } from "convex/nextjs";
import { api } from "../convex/_generated/api";

export async function getAdr(slug: string) {
  return fetchQuery(api.adrs.getBySlug, { slug });
}

export async function getAllAdrs() {
  return fetchQuery(api.adrs.list, {});
}
```

`generateStaticParams()` becomes a Convex query at build time. Individual pages use `dynamicParams = true` + `revalidatePath` so newly-synced ADRs appear without a full rebuild.

### On-Demand Revalidation

After every Convex upsert, the sync function hits:

```
POST /api/revalidate?path=/adrs/{slug}&secret={REVALIDATE_SECRET}
```

This keeps the static page fresh within seconds of an agent write, without a full Vercel redeploy.

## Consequences

**Good:**
- Agent ADR updates are live within ~10 seconds (Inngest + ISR)
- Comments (ADR-0106) become natural Convex relations
- No full redeploy needed for content updates
- Content hash dedup prevents unnecessary revalidation churn
- Future: Convex stores version snapshots for ADR history (ADR-0108)

**Bad:**
- Adds a sync dependency: if Convex is unavailable, ADR reads fail (mitigated by fallback to filesystem for build time)
- `revalidatePath` requires a secret and a Next.js API route
- Initial bulk import must be run once after deploy

**Mitigations:**
- Build-time fallback: `generateStaticParams()` falls back to filesystem if Convex query fails
- Convex is already a hard dependency for comments — this doesn't add a new dependency class
- Bulk import is idempotent (content hash check)

## Related

- ADR-0106: ADR Review Pipeline
- ADR-0021: Memory system (pattern for Convex as projection layer)
