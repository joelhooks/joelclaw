---
type: adr
status: proposed
date: 2026-02-21
tags:
  - adr
  - design-system
  - responsive
  - ui
  - frontend
related:
  - "0087-observability-pipeline-joelclaw-design-system"
  - "0085-data-driven-network-page"
deciders:
  - joel
---

# ADR-0088: JoelClaw Design System — Responsive Layout & Component Architecture

## Status

proposed

## Context

ADR-0087 bundled a design system with the observability pipeline. The pipeline shipped; the design system didn't. The UI that landed is functional but inconsistent — 6 dashboard pages built ad-hoc, each reinventing headers, search, filters, cards, and spacing. The root layout constrains all content to `max-w-2xl` (672px), which works for blog prose but wastes **78%** of Joel's dual Pro Display XDR setup (3008 × 1692 logical pixels per display).

### Current state

| Page | Container | Header style | Responsive | Wide-screen |
|------|-----------|-------------|-----------|-------------|
| `/` (Writing) | inherited 2xl | none | no | 672px on 3008px screen |
| `/network` | inherited 2xl | plain h1 | basic | cramped tables |
| `/dashboard` | inherited 2xl | none | grid-cols-2 | 672px |
| `/system` | max-w-5xl (no effect) | h1+badge | grid-cols-4 (cramped) | 672px |
| `/system/events` | max-w-5xl (no effect) | h1+subtitle | none | 672px |
| `/syslog` | max-w-4xl (no effect) | icon+h1+count | none | 672px |
| `/memory` | max-w-4xl (no effect) | icon+h1+count | flex-wrap | 672px |

Every `max-w-*` on dashboard pages is meaningless — they're all inside the root layout's `max-w-2xl` div.

### Design targets

- **Primary display**: Apple Pro Display XDR — 6016×3384 physical, **3008×1692 logical**
- **Secondary**: iPhone (375-430px), iPad (768-1024px), MacBook Pro (1440-1728px)
- **Aesthetic**: Terminal precision. Monospace-forward. The existing dark theme with `--color-claw: #ff1493` accent is correct — keep it.

## Decision

### 1. Adaptive Root Layout

Remove the hardcoded `max-w-2xl` container from the root layout. Replace with an adaptive system:

```tsx
// Root layout — no max-width constraint
<body>
  <div className="mx-auto px-4 sm:px-6 lg:px-8 xl:px-12">
    <SiteHeader />
    <main>{children}</main>
    <footer>...</footer>
  </div>
</body>
```

Each page or layout group sets its own content width:

- **Prose pages** (Writing, ADR detail, Cool): `<article className="mx-auto max-w-prose">` — keeps ~65ch optimal line length
- **Data pages** (System, Network, Dashboard, Memory, Syslog, Vault): full container width, up to `max-w-[1800px]` with responsive grid

The header and footer span the full container naturally.

### 2. Responsive Breakpoint Strategy

Five breakpoints targeting real devices:

| Token | Width | Target | Layout behavior |
|-------|-------|--------|----------------|
| `sm` | 640px | iPhone landscape / small tablet | Single column, compact spacing |
| `md` | 768px | iPad portrait | 2-column grids |
| `lg` | 1024px | iPad landscape / small laptop | 3-column grids, sidebar potential |
| `xl` | 1280px | MacBook Pro 14" | Full data layouts |
| `2xl` | 1536px | XDR at default scale | Multi-panel, generous spacing |

At XDR width (3008px), `max-w-[1800px] mx-auto` centers content with ~600px margins on each side — data has room to breathe without getting lost.

### 3. Dashboard Page Template

All owner-only data pages follow a consistent structure:

```tsx
export default function DataPage() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-8">
      {/* Page header — consistent across all data pages */}
      <PageHeader
        title="System"
        subtitle="Observability event stream"
        badge={<StatusBadge status={health} />}
        actions={<RefreshButton />}
      />

      {/* Metrics row — responsive grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard ... />
      </div>

      {/* Content area — full width, page-specific */}
      <section>...</section>
    </div>
  );
}
```

### 4. Shared Component Library Evolution

Evolve `packages/ui/src/` with compound component patterns (per Vercel composition patterns skill):

#### PageHeader

Replaces ad-hoc headers across all pages. Consistent spacing, responsive, supports badges and action buttons.

```tsx
<PageHeader title="Network" subtitle="Infrastructure topology" />
<PageHeader title="System" badge={<StatusBadge status="healthy" />} actions={<RefreshButton onClick={load} />} />
```

#### DataGrid

Responsive grid container that adapts column count to viewport:

```tsx
<DataGrid columns={{ sm: 1, md: 2, lg: 3, xl: 4 }}>
  <MetricCard ... />
</DataGrid>
```

#### SearchBar

Unified search input used by Syslog, Memory, System Events, Dashboard:

```tsx
<SearchBar
  value={query}
  onChange={setQuery}
  placeholder="search events..."
  loading={searching}
/>
```

#### EventStream

Evolution of EventTimeline — denser, more terminal-like, with relative timestamps and severity-colored left borders:

```tsx
<EventStream events={events} emptyLabel="no events" />
```

#### MetricCard (enhanced)

Current MetricCard is fine but needs:
- Large number variant for hero metrics
- Responsive sizing (bigger on wide screens)
- Optional mini visualization (bar, ring)

#### StatusBadge (keep as-is)

Already well-designed. No changes needed.

#### FilterBar

Wraps FilterChips with consistent spacing and "all" button styling:

```tsx
<FilterBar
  label="level"
  options={levelOptions}
  selected={level}
  onSelect={setLevel}
/>
```

### 5. Visual Design Tokens

Keep existing tokens from globals.css. Add:

```css
@theme {
  /* Existing */
  --font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, monospace;
  --font-code: var(--font-dank-mono), var(--font-geist-mono), ui-monospace, monospace;
  --font-pixel: var(--font-geist-pixel-square), monospace;
  --color-claw: #ff1493;

  /* New — consistent data page spacing */
  --spacing-page: 2rem;           /* page padding */
  --spacing-section: 2rem;        /* between sections */
  --spacing-card: 0.75rem;        /* between cards in a grid */
  --radius-card: 0.75rem;         /* card border radius */
  --border-subtle: rgba(38, 38, 38, 0.7);  /* neutral-800/70 */
}
```

### 6. Page-Specific Layouts

#### `/system` — Ops Console

Hero health status → 4 metric cards → error rate signal bar → event stream with severity filters. The main observability surface.

#### `/system/events` — Event Explorer

Full-text search → faceted filters (level, source, component) → dense event table with expandable metadata rows. Search-first layout.

#### `/network` — Infrastructure Map

Cluster overview metrics → node cards (expandable on mobile) → pod table → daemon table → stack visualization. Server Component with ISR.

#### `/dashboard` — Command Center

Stats bar → unified search → infrastructure health grid + notification feed (side-by-side on wide screens, stacked on mobile).

#### `/syslog` — Audit Trail

Search → tool filter chips → chronological event timeline. Convex-powered real-time.

#### `/memory` — Observation Browser

Search → category filter chips → observation cards with category badges. Convex-powered real-time.

## Implementation Phases

### Phase 1: Root Layout + PageHeader (foundation)

1. Modify `apps/web/app/layout.tsx` — remove `max-w-2xl`, use adaptive padding
2. Create `packages/ui/src/page-header.tsx` — consistent page headers
3. Create `packages/ui/src/search-bar.tsx` — unified search input
4. Update all 6 data pages + Writing page to set their own max-width
5. Verify: every page renders correctly on mobile (375px) and XDR (3008px)

### Phase 2: Component Refinement

1. Create `packages/ui/src/data-grid.tsx` — responsive grid container
2. Create `packages/ui/src/filter-bar.tsx` — labeled filter chips wrapper
3. Enhance `packages/ui/src/metric-card.tsx` — large variant, responsive sizing
4. Create `packages/ui/src/event-stream.tsx` — dense terminal-style event list (evolution of event-timeline)
5. Update `packages/ui/package.json` exports

### Phase 3: Page Redesigns

1. `/system` — redesign with new components, responsive grids
2. `/system/events` — redesign with SearchBar, FilterBar, dense event table
3. `/network` — responsive tables, better card layout for wide screens
4. `/dashboard` — side-by-side panels at lg+, unified search
5. `/syslog` — consistent with new patterns
6. `/memory` — consistent with new patterns

### Phase 4: Wide-Screen Polish

1. Test all pages at 3008px width — verify nothing looks lost or stretched
2. Add ultra-wide enhancements: larger type scale, multi-column where appropriate
3. Verify mobile (375px) — nothing broken, touch targets adequate
4. Performance: ensure responsive images, lazy loading, no layout shift

## Consequences

### Positive

- Every page uses the same component vocabulary — ship new pages in hours
- XDR gets utilized — data pages fill the screen purposefully
- Mobile isn't an afterthought — responsive from the start
- Composition patterns (Vercel skill) make components flexible without prop bloat
- Clear separation: prose pages stay narrow, data pages go wide

### Negative

- Root layout change affects every page — must verify all routes
- New shared components need maintenance
- Wide-screen design requires more attention to whitespace and density

### Risks

- Layout change could break existing prose pages if max-width isn't pushed down correctly
- Over-engineering components for 6 pages — keep it pragmatic

## Credits

- **Vercel composition patterns** — compound component architecture
- **ADR-0087** — original design system section (extracted here)
- **Tufte CSS** — prose column width rationale (already used for sidenotes)
