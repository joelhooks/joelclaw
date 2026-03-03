# joelclaw SDK (`@joelclaw/sdk`)

Programmatic access to joelclaw command contracts.

## Purpose

Use the SDK when software needs to call joelclaw commands and consume typed JSON envelopes without implementing subprocess and parse plumbing manually.

The SDK currently wraps the CLI binary contract (subprocess transport). This keeps behavior aligned with the operator interface while we incrementally extract direct adapters into reusable packages.

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

## Error model

- `JoelclawProcessError`
  - command timed out, binary missing, non-zero exit, or non-envelope output where envelope expected
  - includes `bin`, `args`, `exitCode`, `signal`, `stdout`, `stderr`
- `JoelclawEnvelopeError`
  - command returned a valid envelope with `ok:false`
  - includes full `envelope`

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
- SDK transport is intentionally conservative right now: CLI parity first, extraction second.
- Keep docs/cli.md and this file updated whenever SDK routes or error semantics change.
