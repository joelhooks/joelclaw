# ADR-0108: Next.js Best Practices Audit

- **Status**: shipped
- **Date**: 2026-02-22
- **Deciders**: Joel, Panda

## Context

joelclaw.com runs Next.js 16.1.5 but doesn't leverage key framework capabilities. An audit against vercel-labs/next-skills identified six gaps:

1. No error boundaries (`error.tsx`, `global-error.tsx`) — failures show blank pages
2. No loading states (`loading.tsx`, `<Suspense>`) — owner pages flash blank→content
3. `ConvexClientProvider` wraps ALL routes in root layout — static pages (blog, ADRs, cool finds, home) ship Convex JS bundle and fire auth queries unnecessarily
4. Relative imports (`../../lib/`) instead of `@/*` path aliases
5. No `cacheComponents` / `'use cache'` directive usage
6. Owner pages do client-side auth redirect instead of middleware

## Decision

### Phase 1 (this ADR)
- Add `app/error.tsx` and `app/global-error.tsx`
- Add `loading.tsx` skeletons for owner pages (vault, memory, syslog, system, dashboard, voice)
- Convert all relative imports to `@/*` aliases across app/ directory
- Keep `ConvexClientProvider` in root layout — too many cross-cutting Convex deps (SiteHeader, MobileNav, ReviewGate on ADR pages) to cleanly separate

### Phase 2 (future)
- Enable `cacheComponents: true` and add `'use cache'` to data functions
- Auth middleware for owner route protection
- Evaluate ConvexProvider scoping once ReviewGate architecture settles
- Rename `middleware.ts` → `proxy.ts` (Next.js 16 convention)

## Consequences

- Static pages (home, blog posts, ADRs, cool finds) become true RSC — no Convex bundle, no client hydration beyond SiteHeader
- Owner pages get proper loading states and error recovery
- Codebase consistency with `@/*` imports

## Risks

- SiteHeader currently uses `authClient.useSession()` to show owner nav — needs reworking since it's in root layout (outside Convex provider). Options: (a) always show public nav in root, add owner nav separately inside (owner) layout, (b) make SiteHeader accept nav items as props
- ReviewGate on ADR pages uses Convex — ADR detail pages may need to stay in a group with Convex access, or ReviewGate needs to lazy-load its provider
- Cool find detail pages use `generateStaticParams` from filesystem — these are true RSC and should stay public

## References

- Skills: `next-best-practices`, `next-cache-components`
- ADR-0106: Review pipeline (ReviewGate dependency on Convex)
