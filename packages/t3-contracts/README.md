# @joelclaw/t3-contracts

Vendored, read-only copy of `@t3tools/contracts` from the T3 Code repo
(`~/Code/pingdotgg/t3code/packages/contracts`). T3's packages are npm-private,
so we carry the source here the same way t3code itself vendors references
under `.repos/`.

- **Do not edit `vendor/`.** Re-vendor with `./sync.sh [t3code-checkout]`.
- `VENDOR.json` records the exact upstream commit.
- Pinned to `effect@4.0.0-beta.103` — the version t3code builds against.
  t3code patches its own effect install, but the patch only adds optional
  RpcClient telemetry hooks; vanilla works for a client (verified 2026-08-23).
- The wire contract only has to match the T3 server build you actually run.
  If the server is updated, re-vendor and bump `effect` to whatever t3code's
  catalog pins.

Consumed by `@joelclaw/t3-client`. Excluded from repo-wide lint/typecheck —
it is upstream code on a different Effect major than the rest of joelclaw.
