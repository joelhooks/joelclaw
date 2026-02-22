---
name: joelclaw-web
description: "Update and maintain joelclaw.com — the Next.js web app at apps/web/. Use when writing blog posts, editing pages, updating the network page, changing layout/header/footer, adding components, or fixing anything on the site. Triggers on: 'update the site', 'write a post', 'fix the blog', 'joelclaw.com', 'update network page', 'add a page', 'change the header', or any task involving the public-facing web app."
---

# joelclaw.com Web App

Next.js app at `apps/web/` in the joelclaw monorepo (`~/Code/joelhooks/joelclaw/`).
Deployed to Vercel on push to `main`. Dark theme, minimal, system-y aesthetic.

## OPSEC Rules

**Never expose real infrastructure details on public pages.**

- **Node/host names**: Use Stephen King universe aliases, never real tailnet hostnames
- **Ports**: Do not publish port numbers for any service
- **Usernames**: Strip `com.joel.` or similar prefixes from service identifiers
- **IPs/subnets**: Never show real IP addresses or CIDR ranges
- **Brands/models of network gear**: Generalize (e.g. "NAS" not "Synology DS1821+")
- **Tailscale**: OK to mention as the mesh VPN product, but no tailnet name or node IPs

Current King universe mapping (network page):
| Role | Alias | Source |
|------|-------|--------|
| Mac Mini (control plane) | Overlook | The Shining |
| NAS (archive) | Derry | IT |
| Laptop (dev machine) | Flagg | The Dark Tower |
| Linux server | Blaine | The Dark Tower |
| Router (exit node) | Todash | The Dark Tower |

## Content Types & Frontmatter

Posts live in `apps/web/content/*.mdx`. Four content types with required frontmatter:

```yaml
---
title: "Post Title"
type: "article" | "essay" | "note" | "tutorial"
date: "2026-02-19T11:00:00"        # ISO datetime, NOT just date
updated: "2026-02-19T14:30:00"     # optional, bumps sort position
description: "One-liner for cards and meta"
tags: ["tag1", "tag2"]
draft: true                         # optional, hides from prod
source: "https://..."               # optional, for video-notes
channel: "Channel Name"             # optional, for video-notes
duration: "00:42:02"                # optional, for video-notes
---
```

**Sorting**: Posts sort by `updated ?? date` descending. Use full ISO datetimes (not bare dates) for deterministic ordering. Setting `updated` bumps a post to the top without changing its original publish date.

**Slugs**: Derived from filename. `my-cool-post.mdx` → `/my-cool-post`.

## Writing Voice

Use the `joel-writing-style` skill for prose. Key traits: direct, first-person, strategic profanity, short paragraphs, bold emphasis, conversational but technical. Never corporate-speak.

## Design System

- **Theme**: Dark (`bg-[#0a0a0a]`), neutral grays, `--color-claw: #ff1493` (hot pink accent)
- **Fonts**: Geist Sans (body), Geist Mono (code/data), Dank Mono (code blocks with ligatures)
- **Content width**: `max-w-2xl` (672px) — intentionally narrow for reading
- **Header**: Single row — claw icon + "JoelClaw" left, nav links + search right. No tagline in header.
- **Nav items**: Writing (`/`), Cool (`/cool`), ADRs (`/adrs`), Network (`/network`)
- **Active nav**: White text vs neutral-500 for inactive, detected via `usePathname()`
- **Search**: ⌘K dialog using pagefind, type-based icons/badges
- **Mobile**: Full-screen overlay nav via `MobileNav` component
- **Code blocks**: Catppuccin Macchiato theme, rehype-pretty-code
- **Sidenotes**: Tufte-style CSS sidenotes (pure CSS, no JS)

## Key Files

| File | Purpose |
|------|---------|
| `app/layout.tsx` | Root layout, fonts, metadata, footer |
| `app/page.tsx` | Home page (post list) |
| `app/[slug]/page.tsx` | Post detail pages |
| `app/adrs/page.tsx` | ADR list |
| `app/adrs/[slug]/page.tsx` | ADR detail (strips H1 to avoid duplicate title) |
| `app/cool/page.tsx` | Cool/discoveries list |
| `app/network/page.tsx` | Infrastructure status page |
| `components/site-header.tsx` | Header with active nav (client component) |
| `components/mobile-nav.tsx` | Mobile overlay nav |
| `components/search-dialog.tsx` | ⌘K search |
| `lib/posts.ts` | Post loading, sorting, types |
| `lib/adrs.ts` | ADR loading from Vault symlink |
| `lib/constants.ts` | Site name, URL, tagline |
| `lib/claw.ts` | SVG path for claw icon |

## ADR Display Rules

- ADRs are synced from `~/Vault/docs/decisions/` via content-sync
- The detail page (`app/adrs/[slug]/page.tsx`) strips the H1 from markdown content because the page already renders the title with ADR number prefix
- Regex: `content.replace(/^#\s+(?:ADR-\d+:\s*)?.*$/m, "").trim()`

## Adding a New Post

1. Create `apps/web/content/my-slug.mdx` with frontmatter (see above)
2. Use ISO datetime in `date` field
3. Add images to `apps/web/public/images/my-slug/` if needed
4. Reference images as `/images/my-slug/filename.png` in MDX
5. Commit and push to `main` — Vercel deploys automatically

## Network Page

The network page (`app/network/page.tsx`) shows real infrastructure with aliased names. When updating:

1. Check actual system state (`kubectl get pods`, `tailscale status`, `launchctl print`, etc.)
2. Apply OPSEC rules — alias all hostnames, strip ports/IPs/usernames
3. Keep data arrays at top of file for easy updates
4. Status dots: green (Online) with ping animation, yellow (Idle), gray (Offline)
