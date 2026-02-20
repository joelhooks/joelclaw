---
slug: joelclaw-auth-better-auth-github-convex
date: 2026-02-20
status: proposed  
author: Joel (via Claude)
tags: [auth, web, github, convex, better-auth]
---

# ADR-0075: joelclaw.com Authentication with Better Auth + GitHub + Convex

## Status

Proposed

## Context

joelclaw.com currently has no authentication. As the site evolves from a static blog to an interactive platform with:
- Agent-specific content and tools
- Personalized experiences
- Community features (comments, discussions)
- Access to private/draft content

We need a robust authentication system that:
- Leverages existing developer identity (GitHub)
- Provides durable persistence
- Scales without operational overhead
- Integrates cleanly with Next.js App Router

Better Auth, GitHub OAuth, and Convex are already configured in production.

## Decision

Implement authentication using:

### 1. **Better Auth** as the authentication framework
- Modern, type-safe auth library designed for Next.js
- Built-in GitHub OAuth provider support
- Session management and JWT handling
- Middleware for route protection

### 2. **GitHub OAuth** as the primary identity provider
- Developers are the target audience
- GitHub is their existing identity
- No password management needed
- Access to GitHub profile data (avatar, bio, repos)

### 3. **Convex** for persistence layer
- Already deployed and configured
- Real-time reactive queries
- Type-safe schema and functions
- Handles user profiles, preferences, sessions

### Architecture

```typescript
// lib/auth.ts
import { betterAuth } from "better-auth";
import { githubProvider } from "better-auth/providers";
import { convexAdapter } from "./convex-adapter";

export const auth = betterAuth({
  providers: [
    githubProvider({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    }),
  ],
  adapter: convexAdapter(),
  callbacks: {
    session: async ({ session, user }) => ({
      ...session,
      user: {
        ...session.user,
        githubUsername: user.githubUsername,
      },
    }),
  },
});
```

### User Flow

1. **Anonymous browsing** — All public content accessible without auth
2. **Sign in with GitHub** — OAuth flow, no passwords
3. **Profile enrichment** — Pull GitHub data, store in Convex
4. **Protected routes** — Middleware guards for agent tools, drafts
5. **Personalization** — Preferences, bookmarks, history in Convex

### Data Model (Convex)

```typescript
// convex/schema.ts
defineSchema({
  users: defineTable({
    githubId: v.string(),
    username: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    createdAt: v.number(),
    lastLogin: v.number(),
    preferences: v.optional(v.object({
      theme: v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
      agentMode: v.boolean(),
    })),
  }).index("by_github_id", ["githubId"]),
  
  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    expiresAt: v.number(),
    userAgent: v.optional(v.string()),
  }).index("by_token", ["token"]),
});
```

### Protected Features

Phase 1 (Immediate):
- Sign in/out flow
- User profile display
- Protect `/agent/*` routes

Phase 2 (Next Sprint):
- Comments on posts (authenticated only)
- Bookmarks and reading history
- Agent tool access controls

Phase 3 (Future):
- Draft post previews for reviewers
- Collaborative features
- API access with personal tokens

## Implementation Plan

1. **Install Better Auth**
   ```bash
   bun add better-auth @better-auth/client
   ```

2. **Configure GitHub OAuth App**
   - Callback URL: `https://joelclaw.com/api/auth/callback/github`
   - Already created, secrets in production

3. **Implement auth routes**
   - `/api/auth/[...all]/route.ts` — Better Auth handler
   - Middleware for protected routes
   - Client hooks for sign in/out

4. **Convex integration**
   - User creation on first sign in
   - Session management functions
   - Real-time auth state

5. **UI Components**
   - Sign in button in header
   - User menu with avatar
   - Loading states during auth

## Consequences

### Positive
- Zero password management
- Leverages existing GitHub identity
- Type-safe from auth to database
- Real-time reactive auth state
- No additional infrastructure

### Negative
- GitHub-only limits audience (intentional)
- Requires GitHub OAuth app management
- Convex vendor lock-in (mitigated by simple schema)

### Alternatives Considered
- **Clerk** — Excellent but overkill for single provider
- **NextAuth** — Being deprecated for Auth.js
- **Supabase Auth** — Would require another service
- **Roll our own** — Security risk, maintenance burden

## Verification Checklist

- [ ] GitHub OAuth app configured with correct URLs
- [ ] Better Auth routes handle sign in/out
- [ ] Convex creates user on first login
- [ ] Protected routes redirect unauthenticated users
- [ ] User menu shows GitHub avatar and username
- [ ] Sessions persist across browser refreshes
- [ ] Sign out clears session in both Better Auth and Convex
- [ ] Production environment variables set