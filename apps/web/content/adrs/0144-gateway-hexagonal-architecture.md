---
status: shipped
date: 2026-02-25
decision-makers: [joel]
---

# ADR-0144: Gateway Hexagonal Architecture (Ports & Adapters)

## Context

The gateway package has grown to ~6K lines with heavy logic embedded in channel files (telegram.ts alone is 1091 lines). Formatting, model fallback, message storage, vault access, and observability are all tightly coupled inside `packages/gateway/`. This makes the gateway hard to test, hard to swap implementations, and creates circular dependency risks as other packages need gateway capabilities.

Joel's directive: "gateway should be very skinny and code to interfaces — ports and adapters."

## Decision

Adopt hexagonal architecture for the gateway. The gateway defines **port interfaces** and delegates to **adapter packages** for all heavy logic.

### Port Interfaces (defined in gateway or shared types package)

| Port | Interface | Current Location | Extract To |
|------|-----------|-----------------|------------|
| **Formatting** | `FormatConverter` | ✅ Done → `@joelclaw/markdown-formatter` | ✅ Shipped |
| **Inference** | `InferenceRouter` | ✅ Done → `@joelclaw/inference-router` | ✅ Shipped |
| **Message Store** | `MessageStore` | ✅ Done → `@joelclaw/message-store` | ✅ Shipped |
| **Model Fallback** | `FallbackStrategy` | ✅ Done → `@joelclaw/model-fallback` | ✅ Shipped |
| **Vault Access** | `VaultReader` | ✅ Done → `@joelclaw/vault-reader` | ✅ Shipped |
| **Observability** | `TelemetryEmitter` | `gateway/observability.ts` (120 lines) | `@joelclaw/telemetry` |
| **Channel** | `Channel` | `gateway/channels/{telegram,slack,discord,imessage}.ts` | Stay in gateway, implement `Channel` interface |
| **Event Bridge** | `EventBridge` | `gateway/channels/redis.ts` (825 lines) | Separate port — not a consumer channel |

### What Stays in Gateway

- Channel wiring (Telegram bot, Discord client, Redis subscriber, iMessage bridge, Slack)
- Session lifecycle and routing
- Composition root: wiring adapters to ports
- Thin `send()` / `receive()` dispatch

### What Moves Out

1. **Message Store** → `packages/message-store/` — Redis-backed conversation history, deduplication, TTL management
2. **Model Fallback** → merge into `packages/inference-router/` — already has catalog + routing, fallback is just another routing strategy
3. **Vault Reader** → `packages/vault-reader/` — file search, path resolution, context enrichment
4. **Telemetry** → `packages/telemetry/` — OTEL event emission, structured logging

### Channel Interface

```typescript
interface Channel {
  readonly platform: ChannelPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: string, options?: SendOptions): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
```

Each channel file implements this interface. The gateway composition root wires channels to the message pipeline.

### Extraction Priority

1. ~~**Model Fallback**~~ → `@joelclaw/model-fallback` ✅ Shipped (2026-02-25, 6 tests)
2. **Message Store** → `@joelclaw/message-store` 🔄 In progress
3. ~~**Vault Reader**~~ → `@joelclaw/vault-reader` ✅ Shipped (2026-02-25, 4 tests)
4. **Telemetry** — deferred (120 lines, 1 export, ~120 call sites — extracting doesn't reduce gateway size, just makes emitter reusable. Low ROI vs channel refactor.)
5. ~~**Channel interface**~~ ✅ Shipped (2026-02-25) — all 4 consumer channels implement `Channel`; Redis scoped as `EventBridge` port

## Consequences

- Gateway shrinks to ~500-800 lines (composition root + channel adapters)
- Each extracted package is independently testable
- Other consumers (CLI, system-bus, agent loops) can import adapters directly
- Channel implementations become pluggable
- Migration is incremental — extract one port at a time, gateway keeps working

## Related

- ADR-0143: AST-based message formatting (first extraction)
- ADR-0140: Unified inference router (second extraction)
