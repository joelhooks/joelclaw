# Review: Content Feedback Pipeline (ADR-0106 + 0084 + 0039)

**Reviewed**: 2026-02-27
**Reviewer**: Claude (pi session, Codex rate-limited)

## 1. Consistency

**Mostly coherent, two issues:**

- **ID scheme mismatch**: ADR-0106 uses `resourceId` throughout but never specifies the format. ADR-0084 defines `article:{slug}` as the ID pattern. The Inngest function in 0106 uses `event.data.resourceId` — make sure the feedback form sends the full `article:{slug}` ID, not just the slug. **Recommendation**: Add an explicit example in 0106 showing `resourceId = "article:mineclaw"`.

- **feedbackItems vs contentResources**: ADR-0106 correctly puts feedback in a separate table (not ContentResource). But ADR-0084's `contentResourceResource` join table could link feedback→article if needed. Currently no cross-reference is defined. **Recommendation**: Decide whether feedbackItems should be linked via the join table or if the `resourceId` foreign key is sufficient. For simplicity, the FK is enough — skip the join table for feedback.

- **ADR-0039 "What Stays Where" update**: Now says articles are migrating to Convex, but the phased rollout table (Phase 2: inline comments) doesn't mention the content migration. **Recommendation**: Add a Phase 1.5 or update Phase 2 to include "Article content migration to ContentResource."

## 2. Gaps

### Migration path (BLOCKER)
ADR-0106 mentions "filesystem MDX can coexist during migration" but gives no concrete strategy. Questions:
- Does the Next.js build still read from filesystem, or does it read from Convex?
- During migration, which is source of truth — MDX file or Convex document?
- How does `getPost()` in `apps/web/lib/posts.ts` change? Does it query Convex instead of `fs.readdirSync`?
- What happens to `generateStaticParams`? Convex can't be called at build time from a static context without a client.

**Recommendation**: Write a migration ADR (0107 or new) that defines: (a) dual-read strategy during transition, (b) seed script to import MDX→Convex, (c) when filesystem becomes read-only shadow copy vs deleted.

### Cache invalidation mechanics
ADR-0106 shows `fetch(\`${SITE_URL}/api/revalidate?tag=article:${resourceId}\`)` but:
- This requires a `/api/revalidate` route handler that calls `revalidateTag()` — doesn't exist yet
- The route needs auth (anyone could bust cache otherwise)
- `cacheTag` + `revalidateTag` is the right pattern for Next.js 16, but `revalidateTag` is a server action / route handler API — confirm it works from an external HTTP call (Inngest worker)

**Recommendation**: Define the revalidation endpoint explicitly. Use a shared secret header for auth.

### Auth for feedback submission
ADR-0106 says `authorId: v.optional(v.string())` — anonymous feedback allowed. But:
- Is this intentional? Anonymous feedback on a personal blog invites spam
- If auth-gated, it depends on ADR-0075 (Better Auth) being implemented first
- No rate limiting mentioned for the feedback mutation

**Recommendation**: Gate behind auth (ADR-0075) for launch. Add Convex rate limiting (max 5 feedback items per user per hour per article).

### Bad agent output
No rollback if the agent produces garbage. The "git history is the safety net" argument doesn't apply — content is in Convex now, not git.

**Recommendation**: Add a `contentRevisions` approval step, or at minimum: (a) always create a revision before overwriting, (b) add a "revert to previous revision" mutation, (c) consider a human-in-the-loop option where Joel approves via Telegram before the revision goes live.

### Error handling
The Inngest function has no error handling. What if:
- `infer()` fails or returns empty?
- Convex mutation fails mid-pipeline (feedback marked processing but never resolved)?
- Cache invalidation fails?

**Recommendation**: Add `onFailure` handler that marks feedback back to `pending` and notifies gateway. Use Inngest's built-in retry for transient failures.

## 3. Gremlin Portability

**joelclaw-specific assumptions baked in:**

| Assumption | Where | Gremlin Impact |
|-----------|-------|----------------|
| `infer()` utility (pi sessions) | 0106 agent-edit step | Gremlin uses different LLM routing — needs adapter |
| `gateway.notify()` | 0106 notify step | Gremlin has no gateway — needs webhook/email adapter |
| `SITE_URL/api/revalidate` | 0106 invalidation step | Gremlin deploys on Vercel — different revalidation |
| Inngest self-hosted | 0106 event flow | Gremlin would use Inngest Cloud or Convex scheduling |
| `cacheTag` / `cacheLife` | 0106 rendering | TanStack Start (gremlin-cms) has no equivalent — Next.js only |

**Recommendation**: Extract the portable core into an interface:
```ts
interface ContentReviewEngine {
  getContent(resourceId: string): Promise<string>
  getFeedback(resourceId: string): Promise<FeedbackItem[]>
  applyEdit(resourceId: string, newContent: string): Promise<void>
  invalidateCache(resourceId: string): Promise<void>
  notify(message: string): Promise<void>
}
```
joelclaw and gremlin implement this differently. The Inngest function orchestrates via the interface, not direct calls.

## 4. Next.js Cache Components

The pattern in ADR-0106 is **correct** for Next.js 16 PPR:
- `'use cache'` + `cacheLife('max')` + `cacheTag` on ArticleContent ✅
- `<Suspense>` boundary around dynamic FeedbackStatus ✅
- Static FeedbackForm (no data fetch) renders in the static shell ✅

**One issue**: `FeedbackStatus` uses `useQuery` (Convex client-side subscription). This means the `ConvexProvider` must wrap the page. If `ConvexProvider` is in the layout, the entire app becomes a client component tree at the layout level. 

**Recommendation**: Use a provider island pattern — wrap only FeedbackStatus in a minimal client boundary:
```tsx
'use client'
function FeedbackStatusIsland({ slug }: { slug: string }) {
  return (
    <ConvexProvider client={convex}>
      <FeedbackStatus slug={slug} />
    </ConvexProvider>
  )
}
```
Or use Convex HTTP queries for status polling instead of subscriptions (simpler, no provider needed, slightly less real-time).

## 5. Inngest Function Design

**Step decomposition**: Good. Each step is independently retriable.

**Concurrency key**: `event.data.resourceId` with limit 1 — correct. Prevents two feedback batches editing the same article simultaneously.

**Missing steps**:
- **Validation step** after agent-edit: verify the output is valid MDX/markdown, non-empty, and roughly the same length (±50%) as the input. Reject wild divergences.
- **Diff generation step**: compute and store the diff before writing the revision (currently `diff: v.optional(v.string())` but nothing generates it)
- **Retry/backoff**: no `retries` config on the function — add `retries: 3` at minimum

**Naming**: Event is `content/review.submitted` — follows the event naming convention ✅

## Implementation Priority

1. **ADR-0075 auth** (blocker — need auth before feedback can be gated)
2. **ContentResource migration for articles** (blocker — need content in Convex)
3. **Feedback Convex schema + mutations** (quick — schema is defined)
4. **Revalidation endpoint** (small — route handler + secret)
5. **Inngest function** (medium — wire up the pipeline)
6. **UI: feedback form → Convex** (medium — replace current dead form)
7. **UI: FeedbackStatus locking indicator** (small — Convex subscription)
8. **UI: revision history** (nice-to-have — can defer)

## Verdict

The architecture is sound. The main blocker is the **MDX → Convex migration path** — without that, the pipeline has no content to update. Write that migration plan first, then the rest follows.
