---
status: shipped
date: 2026-02-21
decision-makers: joel
---

# ADR-0091: Gateway Model Fallback

## Context

The gateway daemon runs on `claude-opus-4-6` (Anthropic). When the Anthropic API is slow or down, the gateway goes unresponsive — messages queue up, heartbeats bounce, and the only recovery is manual restart. On 2026-02-21, the API was sluggish enough that Opus took 4+ minutes with no streaming tokens on a simple test prompt.

The gateway also already has a prompt-racing bug (fixed same day: drain loop now gates on `turn_end`), but API slowness is a separate failure mode that needs its own mitigation.

## Decision

Add automatic model fallback to the gateway daemon:

1. **Dual trigger**: Fallback activates on EITHER:
   - **Timeout**: No streaming tokens received within 90s of prompt dispatch
   - **Consecutive failures**: 2+ prompt errors (catches API errors, auth failures, rate limits)

2. **Fallback model**: Configurable via Redis (`joelclaw:gateway:config` → `fallbackProvider` + `fallbackModel`). Default: `anthropic/claude-sonnet-4-6`. Cross-provider fallback supported (e.g., `openai-codex/gpt-5.3-codex-spark`).

3. **Hot-swap via `session.setModel()`**: Pi's `AgentSession.setModel()` validates API key, updates session state, re-clamps thinking level. No restart needed.

4. **Recovery**: After successful fallback response, set a recovery timer. After 10 minutes on fallback, attempt one prompt on the primary model. If it succeeds within timeout, switch back. If not, stay on fallback.

5. **Notification**: Telegram alert on fallback activation and recovery. Gateway status endpoint reports current model and fallback state.

## Consequences

- Gateway stays responsive even during provider outages
- Cross-provider fallback requires API keys for both providers in the environment
- Fallback model may have different capabilities (e.g., codex-spark has no image support, smaller context)
- Session context is preserved across model swaps — pi handles this internally
- Recovery probe adds one extra API call every 10 minutes while on fallback

## Configuration

Redis key `joelclaw:gateway:config` gains:
- `fallbackProvider`: string (default: "anthropic")
- `fallbackModel`: string (default: "claude-sonnet-4-6")
- `fallbackTimeoutMs`: number (default: 120000) — raised from 90s on 2026-02-22
- `fallbackAfterFailures`: number (default: 3) — raised from 2 on 2026-02-22
- `recoveryProbeIntervalMs`: number (default: 600000)

Gateway start script `ALLOWED_MODELS` must include any configured fallback model.

## Threshold Tuning (2026-02-22)

First 72h showed 8 activations — too aggressive. Raised timeout from 90s→120s and failure threshold from 2→3. Added comprehensive o11y:
- **`prompt.latency`**: per-prompt TTFT and total duration, emitted on every turn end
- **`prompt.near_miss`**: warn when prompt takes >75% of timeout — early signal before actual trips
- **Recovery probes**: elevated to info-level logging with downtime and probe count
- **Activation context**: prompt elapsed time, TTFT, and threshold config included in swap events

This data enables evidence-based threshold tuning going forward.
