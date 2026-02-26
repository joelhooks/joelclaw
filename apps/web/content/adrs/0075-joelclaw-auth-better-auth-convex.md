---
status: deferred
date: 2026-02-21
decision-makers: Joel
tags:
  - adr
  - auth
  - convex
  - web
  - dashboard
type: adr
---

# ADR-0075: JoelClaw Web Auth & Dashboard — Better Auth + Convex

## Status

accepted

## Context

joelclaw.com is currently a static blog (Next.js 16, MDX content). There is no authentication, no database-backed dynamic content, and no way for Joel (or invited users) to interact with the system through the web. Meanwhile, the JoelClaw system has rich data behind the scenes: 2,692 Typesense-indexed documents, 66 Inngest functions, vault notes, memory observations, system logs, discoveries, and blog posts.

### What We Want

1. **Authenticated dashboard** — Joel can see system health, search all indexed data, view recent observations, check Inngest runs, browse discoveries
2. **Search UI** — Typesense search exposed through the web with scoped API keys (search-only, blog + discoveries collections only for public; all collections for authenticated users)
3. **Real-time updates** — Convex subscriptions for live system status, new observations, deploy notifications
4. **Future: multi-user** — Invite trusted collaborators with role-based access

### Why Better Auth

- Open source, self-hosted — no vendor lock-in (unlike Clerk, Auth0)
- Framework-native Next.js integration with App Router support
- Plugin system: GitHub OAuth, 2FA, organizations, admin dashboard
- Works with any database adapter — Convex adapter available
- TypeScript-first with inference

### Why Convex

- Real-time subscriptions out of the box — perfect for live dashboard
- Serverless functions (queries, mutations, actions) with automatic caching
- Schema validation built in
- No infrastructure to manage (hosted service)
- Excellent DX with TypeScript codegen

### Why Not Just Typesense API Keys

Typesense search-only keys work for public blog search, but the dashboard needs:
- User identity (who's searching, who's viewing)
- Access control (admin vs viewer)
- Real-time data that Typesense doesn't store (system status, active loops, queue depth)
- Mutation capability (approve proposals, trigger functions, manage content)

## Decision

Add Better Auth (GitHub OAuth) + Convex to joelclaw.com for authenticated dashboard with real-time data and Typesense-powered search.

### Architecture

```
joelclaw.com (Next.js 16)
├── Public routes (blog, discoveries, public search)
│   └── Typesense search-only key (blog_posts + discoveries collections)
├── /dashboard (authenticated)
│   ├── Better Auth session check (GitHub OAuth)
│   ├── Convex real-time subscriptions
│   │   ├── System health
│   │   ├── Recent observations
│   │   ├── Active loops
│   │   └── Deploy status
│   └── Typesense full search (all collections, auth-gated API key)
└── /api/auth/[...all] (Better Auth handler)
```

### Auth Flow

1. Joel clicks "Sign in" → GitHub OAuth → Better Auth creates session
2. Session stored in Convex (via adapter) + HTTP-only cookie
3. Dashboard routes check session server-side (Next.js middleware or layout)
4. Only `@joelhooks` GitHub user gets admin role (hardcoded allowlist initially)

### Convex Data Model

Convex stores **live operational data** (not content — that stays in Typesense/Vault):

- `users` — Better Auth user records
- `sessions` — Auth sessions
- `systemStatus` — Latest health check results (pushed by Inngest functions)
- `notifications` — Deploy results, loop completions, VIP emails (real-time feed)
- `searchQueries` — Analytics: what's being searched, how often

### Typesense Integration

- **Public**: Scoped search-only key → `blog_posts` + `discoveries` collections
- **Authenticated**: Scoped search-only key → all 6 collections
- Keys generated server-side, never exposed in client bundle
- Search UI component shared between public and dashboard (different key/scope)

## Implementation Plan

**Phase 1: Auth**
- Install `better-auth`, configure GitHub OAuth provider
- Set up `/api/auth/[...all]` route handler
- Create sign-in page (GitHub only, minimal UI)
- Add middleware to protect `/dashboard/*` routes
- Store auth secrets in `agent-secrets`

**Phase 2: Convex**
- Install Convex, configure project
- Define schema: users, sessions, systemStatus, notifications
- Better Auth Convex adapter for session storage
- Real-time queries for dashboard data

**Phase 3: Dashboard UI**
- System health overview (Convex subscription)
- Typesense search (all collections, authenticated)
- Recent observations feed
- Notification stream (deploys, loops, emails)

**Phase 4: Public Search**
- Blog/discovery search widget on public pages
- Typesense scoped key (search-only, 2 collections)

## Consequences

### Positive
- Joel gets a web dashboard for the system he's been managing via CLI only
- Real-time updates via Convex subscriptions (no polling)
- Typesense search exposed to web with proper access control
- Foundation for multi-user access later

### Negative
- New dependency: Convex (hosted service, vendor dependency)
- Auth complexity for a single-user system (initially)
- Two data stores to reason about (Convex for live data, Typesense for search)

### Risks
- Convex free tier limits (should be fine for single-user dashboard)
- Better Auth is newer than NextAuth — less community knowledge (but better DX)

## Audit (2026-02-22)

- Status normalized to `accepted` (from `implementing`) to match canonical ADR taxonomy while preserving ongoing implementation scope.
- Operational evidence reviewed from `system/system-log.jsonl`:
  - `2026-02-21T03:41:06.999Z` (`tool: convex`) project and core schema/functions configured.
  - `2026-02-21T03:44:23.189Z` (`tool: better-auth`) Better Auth + Convex integration deployed with GitHub OAuth and `/api/auth/[...all]`.
  - `2026-02-21T03:59:46.921Z` (`tool: convex`) health pipeline wired into real-time dashboard data flow.
- Full end-to-end closure criteria for all planned phases are not yet captured as complete in this ADR, so status remains `accepted` rather than `implemented`.

## References

- [Better Auth docs](https://better-auth.com/docs)
- [Convex docs](https://docs.convex.dev)
- [ADR-0082: Typesense unified search](0082-typesense-unified-search.md)
- Skills: `create-auth`, `best-practices`, `convex`, `convex-functions`, `convex-schema-validator`, `convex-realtime`
