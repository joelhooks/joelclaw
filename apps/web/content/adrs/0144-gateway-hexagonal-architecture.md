---
status: proposed
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
| **Message Store** | `MessageStore` | `gateway/message-store.ts` (795 lines) | `@joelclaw/message-store` |
| **Model Fallback** | `FallbackStrategy` | `gateway/model-fallback.ts` (382 lines) | `@joelclaw/model-fallback` |
| **Vault Access** | `VaultReader` | `gateway/vault-read.ts` (209 lines) | `@joelclaw/vault-reader` |
| **Observability** | `TelemetryEmitter` | `gateway/observability.ts` (120 lines) | `@joelclaw/telemetry` |
| **Channel** | `Channel` | `gateway/channels/*.ts` (~3K lines) | Stay in gateway but implement `Channel` interface |

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

1. **Model Fallback → inference-router** (small, natural fit)
2. **Message Store** (largest single file, most reusable)
3. **Vault Reader** (clean boundary, used by multiple consumers)
4. **Telemetry** (shared across all packages)
5. **Channel interface refactor** (last — biggest surface area, least urgency)

## Consequences

- Gateway shrinks to ~500-800 lines (composition root + channel adapters)
- Each extracted package is independently testable
- Other consumers (CLI, system-bus, agent loops) can import adapters directly
- Channel implementations become pluggable
- Migration is incremental — extract one port at a time, gateway keeps working

## Related

- ADR-0143: AST-based message formatting (first extraction)
- ADR-0140: Unified inference router (second extraction)
