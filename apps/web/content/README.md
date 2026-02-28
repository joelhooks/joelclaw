# Content

Content lives in **Convex**, not in this directory.

- **ADRs**: authored in `~/Vault/docs/decisions/`, synced to Convex by `system/content-sync`
- **Posts**: authored as MDX, synced to Convex by `system/content-sync`

The production web app reads exclusively from Convex. This directory is an empty skeleton.

See [ADR-0168](../../docs/decisions/0168-convex-canonical-content-lifecycle.md) for the full decision.

## Seeding

```bash
joelclaw content seed    # full Vault → Convex sync
joelclaw content verify  # diff Vault vs Convex, report gaps
```
