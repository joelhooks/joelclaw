---
status: proposed
date: 2026-02-25
deciders: joel
---

# ADR-0145: Channel Message Triage Router

## Context

Slack messages (and other channel traffic) arrive at the gateway session with no filtering. Every message — Kent asking Nicoll about video trims, bot notifications, thread replies Joel doesn't care about — consumes gateway context tokens and triggers agent processing. This wastes inference budget and pollutes the agent's attention.

The gateway session is expensive (Sonnet-class model, 100k+ context). A cheap pre-filter would save 90%+ of wasted tokens on noise.

## Decision

Add a **triage router** that classifies inbound channel messages before they reach the gateway session. Runs as an Inngest function in system-bus, not inside the gateway.

### Classification Categories

| Category | Behavior | Example |
|----------|----------|---------|
| `noise` | Suppress entirely | Bot messages, thread replies between others, automated notifications |
| `fyi` | Batch into periodic digest | Kent discussing video trims with Nicoll, general channel chatter |
| `actionable` | Deliver immediately | Direct questions to Joel, system alerts, deploy failures |
| `joel-mention` | Always deliver, high priority | @joel mentions, DMs to Joel |

### Architecture

```
Channel → Inngest event → triage-router function → classified event → gateway
                              ↓
                     cheap LLM (haiku-class)
                     via inference-router catalog
```

- **Model**: Haiku-4.5 or cheapest capable model from inference-router catalog (ADR-0140). Use `routeInference({ task: "triage", budget: "minimal" })`.
- **Inference**: Via `packages/system-bus/src/lib/inference.ts` (pi sessions, not paid API keys).
- **Debounce/throttle**: Thread messages within a configurable window (default 60s) are batched into a single classification. Prevents 8 messages in a thread from triggering 8 LLM calls.
- **Channel-specific rules**: Hard rules that don't need LLM — bot messages are always `noise`, DMs to Joel are always `actionable`, @mentions are always `joel-mention`. LLM only for ambiguous messages.

### Configuration

`~/.joelclaw/triage.yaml`:
```yaml
triage:
  enabled: true
  model: "haiku-4.5"  # or "auto" to let catalog decide
  
  debounce:
    thread_window_s: 60      # batch thread messages within this window
    channel_window_s: 30     # debounce rapid-fire channel messages
    max_batch_size: 10       # classify up to N messages at once
  
  channels:
    slack:
      enabled: true
      always_noise:
        - "#random"
        - "#general"
      always_deliver:
        - "DM"
      suppress_bots: true
    
    telegram:
      enabled: false  # Joel messages directly, no triage needed
    
    discord:
      enabled: true
      suppress_bots: true
  
  overrides:
    # Per-person overrides
    - match: { author: "kentcdodds" }
      default_category: "fyi"  # unless mentions Joel
    - match: { author: "zac" }
      default_category: "actionable"  # Zac's messages usually matter
```

### Prompt Template

The triage prompt is minimal — just enough context:
```
Classify this Slack message. Reply with ONE word: noise, fyi, actionable.

Channel: #{channel_name}
Author: {author} (not Joel)
Thread: {is_thread_reply}
Message: {text}

Rules:
- noise: doesn't involve Joel, bot output, automated notifications
- fyi: interesting but not urgent, Joel can see in daily digest  
- actionable: needs Joel's attention or decision
```

### Inngest Function

- Trigger: `slack/message.received`, `discord/message.received`
- Debounce: `key: "triage-{channel}-{thread_ts}"`, `period: "60s"`
- Output: `channel/message.triaged` event with `category` field
- Gateway extension filters: only delivers `actionable` and `joel-mention`
- FYI messages accumulate in Redis, delivered as batch digest on heartbeat

## Consequences

- **Gateway context savings**: 80-90% reduction in noise messages
- **Cost**: ~$0.001 per classification with haiku-class model
- **Latency**: Adds 1-2s for debounce + classification, acceptable for non-urgent messages
- **Risk**: False negative on `actionable` — mitigated by `joel-mention` always-deliver rule and per-person overrides
- **Observability**: All classifications logged to OTEL via `@joelclaw/telemetry`

## Related

- ADR-0140: Inference Router (model selection)
- ADR-0144: Gateway Hexagonal Architecture (channel interface)
- ADR-0131: Unified Channel Intelligence Pipeline (superseded approach)
