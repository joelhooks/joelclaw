---
type: discovery
slug: github-as-source-of-truth-crdt-as-working-memory
source: "https://github.com/emotion-machine-org/with-md/tree/main"
discovered: "2026-02-25"
tags: [repo, markdown, collaboration, ai, agents, typescript, nextjs, convex, yjs, vault, memory, agent-loops]
relevance: "Pattern maps directly to Vault-first agent loops: keep Git-tracked Markdown canonical while using CRDT state as transient multi-agent working memory."
---

# GitHub as Source of Truth, CRDT as Working Memory

[with.md](https://with.md) ([repo](https://github.com/emotion-machine-org/with-md)) is a [Markdown](https://www.markdownguide.org/) collaboration system that keeps files in [GitHub](https://github.com/) and treats that repo state as canonical. The app stack—[Next.js](https://nextjs.org/), [Convex](https://convex.dev/), and [Hocuspocus](https://tiptap.dev/docs/hocuspocus/introduction) over [Yjs](https://yjs.dev/)—is familiar, but the framing is the useful part: **real-time collaboration without creating a proprietary document format**.

The clever move is the explicit split between durable content and live session state. Raw `.md` stays portable in Git, while binary [Yjs](https://github.com/yjs/yjs) snapshots preserve cursor/undo collaboration context. They also add defensive rails: [TipTap](https://tiptap.dev/) syntax gating when round-tripping could corrupt content, oversized-doc fallback to source mode, content-loss shrink guards, and multi-strategy anchor recovery for comments. That’s a pragmatic “don’t lose user data” posture instead of editor magic.

For [joelclaw](https://joelclaw.com/) this is relevant to [Vault](https://obsidian.md/) workflows and multi-agent editing patterns: **Git-native artifacts plus CRDT-native collaboration** is a clean model for notes, playbooks, and generated drafts. It lines up with the operating model behind [/system](https://joelclaw.com/system) and event traces in [/system/events](https://joelclaw.com/system/events): durable source, observable transient execution.

## Key Ideas

- [GitHub](https://github.com/) can be the canonical datastore for collaborative docs if local-first sync is handled by [CRDT](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type) state ([Yjs](https://yjs.dev/)).
- Dual persistence (raw [Markdown](https://commonmark.org/) + binary [Yjs](https://github.com/yjs/yjs)) separates portability from collaboration ergonomics.
- [TipTap](https://tiptap.dev/) mode gating based on unsupported syntax is a strong anti-corruption pattern for rich-text editors.
- Comment anchors that combine text quotes, context windows, heading paths, and line fallback are more resilient than naive offsets.
- Size limits and shrink guards are practical safety valves for agent-assisted or multi-user editing systems.

## Links

- Source: https://github.com/emotion-machine-org/with-md/tree/main
- Repository root: https://github.com/emotion-machine-org/with-md
- Project site: https://with.md
- README: https://github.com/emotion-machine-org/with-md/blob/main/README.md
- AGENTS guide: https://github.com/emotion-machine-org/with-md/blob/main/AGENTS.md
- Convex: https://convex.dev/
- Hocuspocus: https://tiptap.dev/docs/hocuspocus/introduction
- Yjs: https://yjs.dev/
- TipTap: https://tiptap.dev/
- ProseMirror: https://prosemirror.net/
- CRDT overview: https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type
- Next.js: https://nextjs.org/
- joelclaw system page: https://joelclaw.com/system
- joelclaw system events: https://joelclaw.com/system/events
