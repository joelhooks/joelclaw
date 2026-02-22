# Static Shell Continuation (apps/web)

## Current state

- Build path is standard Next.js:
  - `build: next build --webpack` in `apps/web/package.json`
- Cache Components are fully enabled:
  - `cacheComponents: true` in `apps/web/next.config.js`
- Public shells remain static; dynamic/runtime behavior is isolated with explicit Suspense seams.

## Hard rules for this repo

1. No `connection()` usage.
2. Keep static shells deterministic:
   - no `Date.now()`
   - no `new Date()` in server static render paths
   - no request-bound reads (`cookies()`, `headers()`) in static shells
3. If personalization is needed, use a dynamic hole:
   - dynamic entry component
   - static shell renderer
   - explicit slot props wrapped with `Suspense`
4. Keep client provider islands local to interactive features.

## Static shell guidance tied to current code

- Global shells (`app/layout.tsx` and shared nav/footer surfaces) should only consume static constants.
- Relative or "now-based" time UI belongs in client-only components and should render deterministic server fallbacks.
- `app/network/page.tsx` must stay offline-safe for build:
  - remote failures return empty collections, not build failures.

## Link prefetch policy

- Keep default prefetch for stable static routes.
- Use `prefetch={false}` for volatile/personalized URLs (query-heavy user paths).

## Ongoing checklist

1. Keep MDX rendering in Suspense-backed dynamic holes when library internals depend on wall-clock/random APIs.
2. Keep Convex provider scope narrow to routes that require Convex hooks.
3. Keep root layout free from request/user-specific reads unless isolated behind Suspense.
4. Verify with:
   - `pnpm --filter web build`
