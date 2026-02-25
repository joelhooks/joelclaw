---
type: adr
status: proposed
date: 2026-02-25
tags: [adr, observability, langfuse, pi, cost-tracking]
deciders: [joel]
related: ["0087-observability-pipeline-joelclaw-design-system", "0092-pi-infer-model-fallback-abstraction"]
---

# ADR-0135: Pi Session Langfuse Instrumentation

## Status

proposed

## Context

JoelClaw's system-bus functions have full Langfuse tracing — 16 functions report model, tokens, cost, and latency via `traceLlmGeneration()`. But the **largest token consumer is invisible**: pi sessions themselves.

### The blind spot

- **Gateway pi session** (Telegram, Discord, Slack conversations) — every turn uses Opus/Sonnet. Zero cost visibility.
- **Codex delegated tasks** — `gpt-5.3-codex` runs with no token tracking.
- **Background agent tasks** — spawned via `background_agent`, no instrumentation.
- **Headless `pi -p` calls** — the `infer()` utility shells to pi. Pi's own token usage is logged to Langfuse via `traceLlmGeneration()` after the fact, but pi itself doesn't emit traces.

The system-bus `infer()` path captures ~30% of total LLM spend. The other ~70% flows through interactive pi sessions with no cost data.

### What we need

Total system cost = system-bus inference + pi session inference + codex inference. Today we only have the first.

## Decision

Instrument pi sessions with Langfuse tracing via a **pi extension** that intercepts turn lifecycle events and emits Langfuse generations.

### Approach: Pi Extension

Pi extensions can hook into the session lifecycle. A `langfuse-trace` extension would:

1. **On turn end**: Extract model, provider, token usage, and cost from the turn response metadata
2. **Emit a Langfuse generation**: Using `@langfuse/otel` or the Langfuse SDK directly
3. **Tag with session context**: session ID, channel (telegram/discord/slack/cli), user, model
4. **Handle codex tasks**: If pi exposes codex task completion events, trace those too

```typescript
// ~/.pi/agent/extensions/langfuse-trace/index.ts
import type { PiExtension } from "@mariozechner/pi-coding-agent";

export default {
  name: "langfuse-trace",
  hooks: {
    onTurnEnd: async (context) => {
      // context.usage has input/output tokens, model, provider, cost
      await traceTurn({
        sessionId: context.sessionId,
        model: context.model,
        provider: context.provider,
        usage: context.usage,
        channel: context.metadata?.channel,
        durationMs: context.durationMs,
      });
    },
  },
} satisfies PiExtension;
```

### Prerequisites

1. **Pi extension API must expose turn-level usage data** — need to verify what `onTurnEnd` (or equivalent) provides. If usage isn't in the hook context, this approach won't work.
2. **Langfuse keys accessible** — already in agent-secrets (`langfuse_public_key`, `langfuse_secret_key`).
3. **Session ID correlation** — Langfuse traces should correlate with the gateway session for end-to-end cost analysis.

### Alternative: Pi CLI wrapper

If the extension API doesn't expose usage, wrap the `pi` binary:

```bash
# ~/bin/pi-instrumented
#!/bin/bash
pi "$@" 2>&1 | tee >(parse-usage-and-send-to-langfuse)
```

This is fragile and loses structured data. Extension approach is strongly preferred.

### Alternative: Anthropic/OpenAI API usage dashboards

Check provider dashboards directly for total spend. But this doesn't give per-session, per-channel, per-function granularity — and Joel uses Pro/Max subscription (not API keys) for pi sessions, so API dashboards don't apply.

## Implementation

1. Read pi extension docs — verify available hooks and context data
2. Build `langfuse-trace` extension at `~/.pi/agent/extensions/langfuse-trace/`
3. Test with a few turns — verify Langfuse receives traces with accurate token counts
4. Add Langfuse dashboard views: cost by channel, cost by model, daily spend trend
5. Optionally: file pi-tools issue requesting richer usage data in extension hooks if needed

## Consequences

### Positive
- Full visibility into total LLM spend across all surfaces
- Per-channel cost breakdown (is Discord or Telegram more expensive?)
- Model cost comparison (Opus vs Sonnet vs Haiku per use case)
- Anomaly detection (sudden cost spikes from runaway loops)
- Data to make informed model selection decisions

### Negative
- Extension adds small latency per turn (Langfuse flush)
- Depends on pi extension API stability
- Langfuse cloud has storage limits on free tier (may need self-hosted)

### Risks
- Pi extension API may not expose token usage — need to verify before building
- Codex tasks may not flow through pi's extension lifecycle at all
