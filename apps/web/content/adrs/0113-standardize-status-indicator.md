---
status: accepted
supersedes: 0088-joelclaw-design-system-responsive-layout.md
date: 2026-02-23
---

# ADR-0113: Standardize page-level status indicator styling

## Context

System-facing pages had inconsistent status rendering. The dashboard header used a small pulsing emerald dot, while the 
`/system` page used a badge-like `StatusBadge` with inline text (`healthy`), and network status was either absent or
inconsistent across sections.

A reusable and accessible standard was needed so status indicators were not copied inline across pages.

## Decision

Use `StatusPulseDot` from `packages/ui/src/status-badge.tsx` as the shared, reusable status indicator for page-level status
prompts where a compact indicator is needed.

- Add/keep `StatusPulseDot` as a first-class UI primitive in `@repo/ui`.
- Use it in `/dashboard` (header) and `/system` page header status area.
- Use it in `/network` for the top-level network health summary.
- Use `StatusPulseDot` props `status` and `label` for accessible/hover text rather than rendering explicit text labels adjacent
  to the dot in those contexts.

For richer status chips that include status text, keep `StatusBadge` where explicitly needed.

This updates the previous guidance in ADR-0088 ("StatusBadge keep as-is") for page-level status display to prefer the shared
pulsing dot style.

## Consequences

- More consistent status visuals across observability pages.
- Lower copy-paste markup in route components.
- Accessible hover text is preserved via native `title`/`aria-label` on the status indicator.
