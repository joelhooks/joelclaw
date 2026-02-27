---
type: discovery
slug: constrained-generation-agent-driven-ui
source: "https://github.com/vercel-labs/json-render"
discovered: "2026-02-27"
tags: [repo, ai, typescript, generative-ui, agent-loops, course-builder, shadcn, remotion, react-native, json-schema]
relevance: "json-render's catalog-constrained AI output pattern maps directly to course-builder UI generation and agent-driven interface composition in joelclaw"
---

# Constrained Generation as the Missing Layer in Agent-Driven UI

The reason most "AI generates your UI" demos break down in production is that the AI has too much freedom. It can emit anything — arbitrary JSX, unmapped components, props that don't match your types. [json-render](https://github.com/vercel-labs/json-render) solves this by inverting the problem: instead of giving the AI free reign and sanitizing on the way out, you define a **component catalog** upfront, and the AI can only generate within those bounds. The output is a typed JSON spec. The renderer is just a lookup table. The guardrails are structural, not vibes.

The catalog pattern is genuinely elegant. You define components with [Zod](https://zod.dev/) schemas for their props and plain-English descriptions that go into the AI's system prompt. The model produces a flat spec — root key plus an elements map — and the `Renderer` walks it. No eval, no unsafe innerHTML, no escape hatches. If the AI tries to emit a component that isn't in the catalog, it simply doesn't render. **The schema is the contract.** That's a better guarantee than any prompt-based guardrail.

What makes this interesting for the [course-builder](https://github.com/joelhooks/course-builder) angle is the cross-platform story. The same catalog definition works across [React](https://react.dev/), [Vue](https://vuejs.org/), [React Native](https://reactnative.dev/), [Remotion](https://www.remotion.dev/), and [react-pdf](https://react-pdf.org/) — same AI-generated spec, different renderers. That's a real unlock for agent-driven content pipelines: an agent generates a spec once, and you render it as a dashboard, a PDF invoice, a mobile screen, or a Remotion video frame without touching the generation logic. The [@json-render/shadcn](https://github.com/vercel-labs/json-render) package ships 36 pre-built [shadcn/ui](https://ui.shadcn.com/) components ready to drop in — Button, Card, Table, Badge, the usual suspects — which means you can be dangerous in under an hour without writing component implementations from scratch.

State and actions are first-class too. The `emit` function in component definitions fires named actions back to your app logic, and there are adapters for [Redux](https://redux.js.org/), [Zustand](https://zustand-demo.pmnd.rs/), [Jotai](https://jotai.org/), and [XState](https://stately.ai/xstate) to wire up the `StateStore`. That means AI-generated UIs aren't just static displays — they can have dynamic props, local state, and side effects, all while staying within the sandbox.

## Key Ideas

- **Catalog = guardrails**: AI output is structurally constrained to components you've defined with Zod schemas — no arbitrary component generation, no unmapped props
- **Flat spec format**: `{ root: string, elements: Record<string, Element> }` — simple enough to stream, easy to validate, renderer is a pure lookup
- **Progressive streaming**: specs can render incrementally as the model streams tokens via `SpecStream` utilities in `@json-render/core`
- **Cross-platform from one spec**: React, Vue, React Native, Remotion, react-pdf all consume the same JSON spec through platform-specific renderers
- **36 pre-built shadcn/ui components** in `@json-render/shadcn` — drop-in catalog for web UI without writing component impls
- **Actions and state bindings**: `emit()` in components + state adapters (Redux, Zustand, Jotai, XState) make generated UIs interactive, not just static
- **Remotion renderer** enables AI-generated video specs — timeline/track/clip format for programmatic video composition
- **react-pdf renderer** means the same AI can generate PDF documents (invoices, reports) from a structured spec — no LaTeX, no template wrangling
- **From Vercel Labs**, the experimental arm of [Vercel](https://vercel.com/) — not production-stable but backed by real engineering attention
- **Turbo monorepo** structure with isolated packages — can pull just `@json-render/core` + the renderer you need without the full tree

## Links

- [json-render repo](https://github.com/vercel-labs/json-render) — Vercel Labs, MIT license
- [Vercel Labs](https://github.com/vercel-labs) — experimental projects from Vercel engineering
- [@json-render/shadcn](https://github.com/vercel-labs/json-render/tree/main/packages/shadcn) — 36 pre-built shadcn/ui components
- [shadcn/ui](https://ui.shadcn.com/) — the underlying component system
- [Remotion](https://www.remotion.dev/) — React-based video rendering, used in json-render's video renderer
- [react-pdf](https://react-pdf.org/) — PDF generation from React, json-render's PDF renderer target
- [Zod](https://zod.dev/) — schema validation library used for catalog prop definitions
- [course-builder](https://github.com/joelhooks/course-builder) — Joel's course platform, potential integration target for agent-driven UI generation
- [AI SDK by Vercel](https://sdk.vercel.ai/) — natural pairing for structured output + json-render spec generation
