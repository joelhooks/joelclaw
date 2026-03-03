# joelclaw SDK (`@joelclaw/sdk`)

Programmatic access to joelclaw command contracts.

## Purpose

Use the SDK when software needs typed access to joelclaw behavior without reimplementing CLI parsing and process control.

The SDK now supports both subprocess and in-process execution:

- `transport: "subprocess"` — always shell out to `joelclaw`
- `transport: "inprocess"` — never shell out; uses SDK capability adapters directly (currently `otel` and `recall`)
- `transport: "hybrid"` (default) — in-process first for supported capabilities, subprocess fallback otherwise

## Installation (workspace)

```ts
import { createJoelclawClient } from "@joelclaw/sdk"
```

## Client setup

```ts
const client = createJoelclawClient({
  bin: process.env.JOELCLAW_BIN, // optional, defaults to JOELCLAW_BIN or "joelclaw"
  cwd: process.cwd(),            // optional working directory
  timeoutMs: 20_000,             // optional per-call default timeout
  transport: "inprocess",       // "subprocess" | "inprocess" | "hybrid"
})
```

## Core methods

### Generic

- `run(args, options)` — returns parsed envelope, does not throw on `ok:false`
- `runOrThrow(args, options)` — throws `JoelclawEnvelopeError` on `ok:false`
- `runText(args, options)` — raw stdout for non-envelope commands

### Typed convenience routes

- `status()`
- `otelList/search/stats/emit`
- `recall(query, options)`
- `recallRaw(query, options)`
- `vaultRead/search/ls/tree`
- `vaultAdrList/collisions/audit/rank`

### Direct capability runtime

The SDK exports capability adapters and a runtime entrypoint:

- `executeSdkCapabilityCommand({ capability, subcommand, args })`
- adapters: `typesenseOtelAdapter`, `typesenseRecallAdapter`

This is the canonical in-process path now used by SDK transport and reused by CLI adapter wrappers.

## Error model

- `JoelclawProcessError`
  - command timed out, binary missing, non-zero exit, or non-envelope output where envelope expected
  - includes `bin`, `args`, `exitCode`, `signal`, `stdout`, `stderr`
- `JoelclawEnvelopeError`
  - command returned a valid envelope with `ok:false`
  - includes full `envelope`
- `JoelclawCapabilityError`
  - in-process capability execution failed (`transport: "inprocess"`)
  - includes capability, subcommand, code, and fix guidance

## OTEL emit examples

```ts
await client.otelEmit("system.sdk.ping")

await client.otelEmit({
  action: "system.sdk.ping",
  source: "sdk",
  component: "integration-test",
  level: "info",
  success: true,
  metadata: { suite: "smoke" },
})
```

## Notes

- Envelope schema mirrors CLI contract in `packages/cli/src/response.ts`.
- OTEL + recall adapter logic now lives in `packages/sdk/src/capabilities/adapters/*` and is consumed by CLI wrapper adapters.
- Keep docs/cli.md and this file updated whenever SDK routes, capability adapters, or transport semantics change.
