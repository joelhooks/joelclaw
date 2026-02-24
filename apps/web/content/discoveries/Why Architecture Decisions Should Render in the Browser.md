---
type: discovery
slug: why-architecture-decisions-should-render-in-the-browser
source: "https://github.com/nicobailon/visual-explainer"
discovered: "2026-02-24"
tags: [repo, tool, pattern, ai, cli, typescript, pi, architecture, adr, agent-loop, vault, visualization]
relevance: "Useful for [ADR review checkpoints](https://joelclaw.com/adrs/0015-loop-architecture-tdd-roles) in the [agent loop](https://joelclaw.com/adrs/0015-loop-architecture-tdd-roles), because `diff-review` and `plan-review` artifacts could become the loop’s handoff format instead of terminal-only noise."
---

# Why Architecture Decisions Should Render in the Browser

[**visual-explainer**](https://github.com/nicobailon/visual-explainer) by [Nico Bailon](https://github.com/nicobailon) is a [Pi](https://github.com/mariozechner/pi-coding-agent) / [Claude](https://www.anthropic.com) style skill that replaces terminal-heavy explanation output with a full [HTML](https://developer.mozilla.org/en-US/docs/Web/HTML) artifact. It watches for requests like `/generate-web-diagram`, `/diff-review`, and `/plan-review`, then emits a file under `~/.agent/diagrams/` for quick browser review, with no build step and minimal tooling beyond the model and a browser.

The clever part is the decision boundary: once output size crosses `4x3` table complexity or turns into a tangle of [ASCII](https://en.wikipedia.org/wiki/ASCII_art) boxes, it auto-routes to templates tuned for [Mermaid](https://mermaid.js.org/) diagrams, [CSS Grid](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout) architecture cards, and structured tables with [Chart.js](https://www.chartjs.org/)-style sections. It is, in other words, an attempt to make architecture explanation **consumable** for people who are already drowning in code. The prompt set is explicit about use cases: plan verification, diff review, fact-checking claims, and context-recapture after a day away.

For this system, that matters because the loop architecture already depends on explicit checkpoints—[planning](https://joelclaw.com/adrs/0012-planner-generates-prd), [review](https://joelclaw.com/adrs/0015-loop-architecture-tdd-roles), and [memory](https://joelclaw.com/adrs/0014-agent-memory-workspace). A browser-rendered review artifact gives each stage a concrete, shareable artifact the next model (or human) can skim quickly. It also aligns with how [ADRs](https://joelclaw.com/adrs/0015-loop-architecture-tdd-roles) already function in this repo: decision intent plus rationale, not just terminal output.

This feels like a practical upgrade path for Joel’s [Vault](https://github.com/joelhooks/joelclaw/tree/main/Vault) and architecture hygiene if we treat visualization as infrastructure. A lot of friction in this stack starts when a good design exists only as text output; visual-explainer’s model is that structure should be generated once and reused by handoff tooling later.

## Key Ideas

- The [repository structure](https://github.com/nicobailon/visual-explainer/tree/main) makes the rendering model explicit: [SKILL.md](https://github.com/nicobailon/visual-explainer/blob/main/SKILL.md) defines workflow, [references/](https://github.com/nicobailon/visual-explainer/tree/main/references) define design systems, and [templates/](https://github.com/nicobailon/visual-explainer/tree/main/templates) define output types.
- The `diff-review` flow is tailored for implementation checkpoints and already includes architecture comparison, risk notes, and decision logging, which maps cleanly to the loop stages where this repo already tracks [observability](https://joelclaw.com/adrs/0006-observability-prometheus-grafana).
- A single-file output directory (`~/.agent/diagrams/`) creates a simple retention point, which is unusual compared with ephemeral terminal artifacts and is attractive for [replayability](https://martinfowler.com/bliki/DocumentationDebt.html).
- The skill is [spec-compliant with the Agent Skills standard](https://agentskills.io/specification), which makes installation and extension predictable for existing skill ecosystems.
- It can be installed side-by-side with existing Pi and [Claude](https://www.anthropic.com/product/claude) skill trees via `git clone` and prompt template copy, so adoption can be incremental.

## Links

- [visual-explainer repository](https://github.com/nicobailon/visual-explainer)
- [visual-explainer README](https://github.com/nicobailon/visual-explainer/blob/main/README.md)
- [Nico Bailon's GitHub profile](https://github.com/nicobailon)
- [Agent Skills specification](https://agentskills.io/specification)
- [Anthropic skills reference project](https://github.com/anthropics/skills)
- [interface-design skill source](https://github.com/Dammyjay93/interface-design)
- [Mermaid documentation](https://mermaid.js.org/)
- [Chart.js documentation](https://www.chartjs.org/)
- [joelclaw ADR-0015: loop architecture and TDD roles](https://joelclaw.com/adrs/0015-loop-architecture-tdd-roles)
- [joelclaw ADR-0012: planner generates PRD](https://joelclaw.com/adrs/0012-planner-generates-prd)
- [joelclaw ADR-0014: agent memory workspace](https://joelclaw.com/adrs/0014-agent-memory-workspace)