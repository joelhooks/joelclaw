---
type: discovery
slug: living-pattern-catalogs-that-keep-your-architecture-honest
source: "https://simonwillison.net/guides/agentic-engineering-patterns/"
discovered: "2026-02-24"
tags: [article, ai, agent-loops, architecture, patterns, prior-art]
relevance: "living reference of agentic patterns maps directly to joelclaw agent loop roles, event fan-out, and tool-use decisions"
---

# Living Pattern Catalogs That Keep Your Architecture Honest

[Simon Willison](https://simonwillison.net/) maintains a **living guide to agentic engineering patterns** — not a blog post that decays, but a document he updates as the field moves. That distinction matters. Most writing about agent architecture is a snapshot. This is a rolling audit of what actually works, maintained by someone who builds with these tools daily and writes about them with [uncommon rigor](https://simonwillison.net/tags/ai/).

The value here isn't just "smart person wrote a patterns doc." It's that a well-maintained, opinionated catalog of patterns from a credible practitioner becomes **prior art you can pressure-test your own decisions against**. Every architectural choice in [joelclaw's agent loop system](/adrs/agent-loop-architecture) — the [five separated roles](https://github.com/joelhooks/joelclaw), the [Inngest](https://www.inngest.com/) step-based durability, the fan-out and cross-checking — either aligns with a documented pattern or deliberately diverges from one. Both are useful signals. Alignment means you're not inventing where you don't need to. Divergence means you'd better have a reason.

Simon's broader body of work on [LLM tooling](https://llm.datasette.io/en/stable/), [Datasette](https://datasette.io/), and the [shot-scraper](https://github.com/simonw/shot-scraper) ecosystem reflects the same philosophy: **build small composable tools, document them publicly, iterate in the open**. That's the same bet behind joelclaw's CLI-first, event-driven approach. The patterns guide is worth monitoring not because it tells you what to build, but because it tells you what other people are converging on — and where you might be building something nobody else needs.

Worth revisiting quarterly as a sanity check against your own [ADRs](/adrs).

## Key Ideas

- **Living documents beat blog posts** for fast-moving domains — a guide that updates is more useful than a post that was correct six months ago
- **Pattern catalogs as architecture mirrors** — comparing your system's choices against a canonical list surfaces both validation and blind spots
- **Simon Willison's documentation practice** is itself a pattern worth studying — public, iterative, tool-assisted, high-volume, and [relentlessly honest](https://simonwillison.net/2024/Dec/19/soul-of-a-new-machine/)
- **Agentic engineering is converging on shared vocabulary** — role separation, tool use, human-in-the-loop gates, multi-model verification — and this guide tracks that convergence
- **Composable small tools over monolithic agents** is a recurring theme in Simon's work, echoing joelclaw's CLI-first and [event-bus](https://www.inngest.com/docs) architecture

## Links

- [Agentic Engineering Patterns Guide](https://simonwillison.net/guides/agentic-engineering-patterns/) — the source, living document
- [Simon Willison's Blog](https://simonwillison.net/) — prolific writing on LLMs, tools, and open source
- [LLM CLI Tool](https://llm.datasette.io/en/stable/) — Simon's command-line tool for working with language models
- [Datasette](https://datasette.io/) — Simon's tool for exploring and publishing data
- [shot-scraper](https://github.com/simonw/shot-scraper) — browser automation tool, same composable-tools philosophy
- [Simon Willison on GitHub](https://github.com/simonw)
- [Simon Willison on Mastodon](https://fedi.simonwillison.net/@simon)
