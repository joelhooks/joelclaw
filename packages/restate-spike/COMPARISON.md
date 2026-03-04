# Restate Spike Comparison (vs self-hosted Inngest)

Date: 2026-03-04
Scope: Durable execution evaluation for joelclaw workloads (step chains, fan-out/fan-in orchestration, and human-in-the-loop approvals/signals).

## API Mapping: Inngest → Restate

| Inngest concept | Restate equivalent | Notes |
|---|---|---|
| `createFunction()` with trigger | `restate.service()` / `restate.workflow()` handlers | Restate favors RPC/service/workflow invocation over event-trigger-first design. |
| `step.run("name", fn)` | `ctx.run("name", fn)` | Both provide durable, replay-safe step memoization. |
| `step.sleep("duration")` | `ctx.sleep({ ... })` | Similar durability and resumability semantics. |
| `step.waitForEvent(...)` | `ctx.promise("key")` + external resolve handler | Signal/promise model is explicit and ergonomic for approvals. |
| Event fan-out (`step.sendEvent`) | Service-to-service calls (`ctx.serviceClient(...)`) | Restate is direct RPC-like orchestration; Inngest is event-native fan-out. |
| Inngest run graph/console | Restate admin + invocation metadata | Inngest UI is currently stronger for event lineage clarity. |
| Queueing/retries via function config | Durable execution in runtime with replayed steps | Both are durable; control knobs differ and need policy mapping. |

## What feels better in Restate

- First-class services/workflows model matches long-lived orchestrators and request/response patterns naturally.
- Promise/signal approach for approvals is straightforward and maps cleanly to human-in-the-loop flows.
- Built-in service client ergonomics make fan-out/fan-in orchestration concise.
- Durable step API (`ctx.run`) is conceptually close to Inngest `step.run`, reducing cognitive migration cost.

## What is worse or missing (for joelclaw today)

- Event-driven topology is not the default mental model; joelclaw is currently deeply event-centric around Inngest.
- Existing CLI/operator surface (`joelclaw runs/run/send/loop`) assumes Inngest semantics and would need adapter work.
- Current function estate (110+ Inngest functions, middleware, event naming conventions) implies large migration surface.
- Operational runbook maturity is higher for current Inngest deployment (k8s + worker split + telemetry habits).

## Migration effort estimate

- **Prototype (this spike-level parity):** 1–2 days (completed structure + representative flows).
- **Dual-run pilot (selected workflows mirrored):** 1–2 weeks.
- **Core pipeline migration (high-volume production functions):** 4–8+ weeks, depending on compatibility wrappers and observability parity requirements.

## Recommendation

- Keep Inngest as the production durable backbone for now.
- Continue with a **dual-run Restate pilot** for 1-2 high-value orchestration flows (approval + swarm wave) to measure: failure semantics, operator UX, and implementation velocity.
- Decide go/no-go after objective metrics (implementation effort, incident rate, mean time to diagnose, and run visibility) from the pilot window.
