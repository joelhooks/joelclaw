---
type: discovery
slug: liveview-muscle-memory-in-a-60-fps-terminal-renderer
source: "https://github.com/LoamStudios/courgette"
discovered: "2026-02-25"
tags: [repo, elixir, otp, tui, terminal-ui, liveview, flexbox, agent-interfaces]
relevance: "Courgette’s mount/render/handle_event lifecycle is a strong reference for stateful, keyboard-first operator UIs in Joel’s terminal-heavy system tooling."
---

# LiveView Muscle Memory in a 60 FPS Terminal Renderer

[Courgette](https://github.com/LoamStudios/courgette) is a clean idea: take the [Phoenix LiveView](https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.html) mental model (`mount`, `render`, `handle_event`) and run it straight in the terminal on [Elixir](https://elixir-lang.org/) + [OTP](https://www.erlang.org/doc/apps/erts/). It’s still marked work-in-progress, but the shape is already compelling because the component model is familiar and the target is different.

The clever bit is the rendering stack. It goes from element tree → layout → paint buffer → diff → [ANSI](https://en.wikipedia.org/wiki/ANSI_escape_code), with double buffering and frame batching around ~60 FPS. Layout is [Flexbox](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout) via a port of [taffy](https://github.com/DioxusLabs/taffy), and input support includes full keyboard, mouse, focus, paste, and resize events. So this isn’t just "draw text" — it’s a serious terminal UI runtime.

Useful for Joel’s world even without adopting Elixir. The patterns map to how we think about stateful control surfaces in [joelclaw](https://github.com/joelhooks/joelclaw): event-driven updates, minimal redraw, and deterministic tests for behavior. The headless component test helpers and explicit focus management are the pieces worth stealing first, especially for terminal-facing ops surfaces tied to [system events](https://joelclaw.com/system/events).

## Key Ideas

- [Courgette](https://github.com/LoamStudios/courgette) applies [Phoenix LiveView](https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.html)-style lifecycle callbacks (`mount`, `render`, `handle_event`) to terminal apps instead of browser apps.
- Stateful components are process-backed with [GenServer](https://hexdocs.pm/elixir/GenServer.html), while stateless function components stay lightweight and composable.
- Layout uses a terminal-adapted [taffy](https://github.com/DioxusLabs/taffy) engine, bringing real [Flexbox](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout) semantics (`flex_grow`, `justify_content`, `align_items`, etc.) to TUIs.
- Rendering is incremental and double-buffered, emitting minimal [ANSI escape sequences](https://en.wikipedia.org/wiki/ANSI_escape_code) instead of repainting the full screen every tick.
- Input support is unusually complete for early-stage TUI frameworks, including [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/), mouse events, bracketed paste, focus tracking, and resize handling.
- Semantic theme tokens (`primary`, `danger`, `muted`) are built in, which nudges apps toward consistent UI systems instead of hard-coded color soup.
- Headless test helpers make full lifecycle tests deterministic, which matters for agent/operator interfaces where regressions hide in event handling and focus logic.

## Links

- [Courgette repository](https://github.com/LoamStudios/courgette)
- [Courgette architecture guide](https://github.com/LoamStudios/courgette/blob/main/guides/architecture.md)
- [Courgette examples directory](https://github.com/LoamStudios/courgette/tree/main/examples)
- [Phoenix LiveView docs](https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.html)
- [Elixir language](https://elixir-lang.org/)
- [Erlang/OTP docs](https://www.erlang.org/doc/)
- [Taffy layout engine](https://github.com/DioxusLabs/taffy)
- [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)
- [ANSI escape codes reference](https://en.wikipedia.org/wiki/ANSI_escape_code)
- [joelclaw repository](https://github.com/joelhooks/joelclaw)
- [joelclaw system events page](https://joelclaw.com/system/events)
