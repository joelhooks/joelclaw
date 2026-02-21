---
type: discovery
slug: reactive-database-absorbs-server-layer
source: "https://github.com/get-convex/convex-backend"
discovered: "2026-02-21"
tags: [repo, typescript, rust, infrastructure, database, real-time, self-hosted, serverless, event-bus]
relevance: "single reactive backend could unify Inngest durable functions + Redis state + real-time sync for joelclaw"
---

# Reactive Database That Absorbs the Server Layer

[Convex](https://convex.dev) open-sourced their backend and made it [self-hostable](https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md). The pitch: write pure TypeScript functions, get strong consistency, real-time reactivity, and serverless execution — all from one system. No separate database. No separate function runtime. No separate WebSocket layer for live updates. **One binary does all of it.**

The [architecture](https://docs.convex.dev/understanding/) is [Rust](https://www.rust-lang.org/) under the hood with a [V8 isolate](https://v8.dev/) layer for running TypeScript functions. Queries are reactive by default — clients subscribe and get automatic updates when underlying data changes. Mutations are transactional with [strong consistency](https://docs.convex.dev/understanding/), not eventual. This is the database-as-backend pattern taken seriously: the data layer *is* the server layer. [Jamie Turner](https://github.com/jamie-convex) and the [Convex team](https://github.com/get-convex) have been building this since ~2022, and the [self-hosted path](https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md) works via Docker or a prebuilt binary. Plays well with [Neon](https://neon.tech/), [Fly.io](https://fly.io/), [Vercel](https://vercel.com/), [Netlify](https://www.netlify.com/). There's a generous [free cloud tier](https://www.convex.dev/plans), but the self-hosted route is what matters for sovereignty.

For [joelclaw](/adrs/joelclaw), this is a future exploration — not immediate. The current stack ([Inngest](https://www.inngest.com/) for durable functions, [Redis](https://redis.io/) for state, [Qdrant](https://qdrant.tech/) for vectors) works. But the idea of a **single reactive system** that handles server functions AND real-time data sync is worth tracking. Agent state that multiple clients need to observe simultaneously — gateway sessions, loop progress, memory queries — currently requires stitching together several services. Convex's model collapses that into one thing. The [Discord community](https://discord.gg/convex) has a `#self-hosted` channel that's active, which is a good sign for long-term viability.

## Key Ideas

- **Reactive queries as the default** — clients subscribe to query results and get automatic updates when data changes, no polling or manual WebSocket wiring needed ([docs](https://docs.convex.dev/understanding/))
- **Pure TypeScript server functions** — queries and mutations are just TypeScript, executed in [V8 isolates](https://v8.dev/) with strong consistency guarantees, not a bolted-on lambda layer
- **Rust backend, single binary** — the [crates/](https://github.com/get-convex/convex-backend/tree/main/crates) directory is a serious Rust codebase covering database, [isolate runtime](https://github.com/get-convex/convex-backend/tree/main/crates/isolate), [file storage](https://github.com/get-convex/convex-backend/tree/main/crates/file_storage), [shape inference](https://github.com/get-convex/convex-backend/tree/main/crates/shape_inference), and more
- **Self-hosting is a first-class path** — Docker or binary, includes dashboard and CLI, not a "good luck" afterthought ([self-hosting guide](https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md))
- **Database absorbs the server** — no separate API layer, no separate function runtime, no separate real-time transport; the database IS the backend
- **Transactional mutations with strong consistency** — not eventual consistency, not CRDTs, actual transactions across the whole dataset

## Links

- [convex-backend repo](https://github.com/get-convex/convex-backend) — the open-source Rust backend
- [Convex docs](https://docs.convex.dev/) — getting started, architecture, API reference
- [Convex cloud platform](https://www.convex.dev/plans) — hosted offering with free tier
- [Self-hosting guide](https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md) — Docker and binary setup
- [Convex Discord](https://discord.gg/convex) — community support, `#self-hosted` channel
- [BUILD.md](https://github.com/get-convex/convex-backend/blob/main/BUILD.md) — building from source
- [CONTRIBUTING.md](https://github.com/get-convex/convex-backend/blob/main/CONTRIBUTING.md) — contribution guidelines
