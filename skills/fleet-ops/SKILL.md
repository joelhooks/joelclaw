---
name: fleet-ops
displayName: Fleet Operations
description: "Inspect JoelClaw Mac fleet harness drift safely. Use for fleet status/diff, role-aware Pi and skill-policy checks, or planning a reviewed fleet change."
version: 0.1.0
author: joel
tags:
  - joelclaw
  - fleet
  - macos
  - pi
  - operations
---

# Fleet Operations

Use this to inspect the JoelClaw Mac fleet without flattening intentional role differences into fake drift.

Panda is Central. Satellites stay thin. A role difference is policy only when the local private fleet manifest says why.

## Current commands: read-only

```bash
joelclaw fleet status
joelclaw fleet diff
```

Both commands read the local private fleet manifest and return JSON envelopes. They do not install packages, copy config, request repair, change services, or rewrite a Machine.

Use `--host <alias>` to inspect one declared host. Do not pass an undeclared target or publish the private manifest.

`status` reports observed facts and probe failures. `diff` classifies declared fields as:

- `in_sync`
- `expected_difference` — an explicit manifest exemption, including its reason
- `drift` — an actionable mismatch
- `unavailable` — a required fact could not be read

A failed or unavailable satellite health probe is actionable. Thin satellite skill policy alone is not.

## Operator flow

1. **Probe** — run `joelclaw fleet status`.
2. **Classify** — run `joelclaw fleet diff`; read the exemption reason before calling a difference wrong.
3. **Inspect** — verify unexpected drift with the relevant host/runbook. Do not infer host identity from an SSH alias alone.
4. **Plan** — write a host-scoped, reviewable change plan. Fleet `plan` does **not** exist yet.
5. **Approve** — get explicit approval for any mutation.
6. **Apply** — use the approved, host-specific mechanism. Fleet `apply` does **not** exist yet. Never pretend it does.
7. **Verify** — rerun `status` and `diff`, then capture a redacted receipt.

If a probe cannot reach a host, record `unavailable` and keep gathering the other hosts. Do not turn on Remote Login, alter Tailscale, copy credentials, or bootstrap a Machine as a side effect of an audit.

## Role boundaries

- **Central:** Panda owns the heavy runtime. Verify Central health through the established system runbooks before changing it.
- **Satellite:** keep the Machine local, small, and recoverable. Load [Satellite Rig](../satellite-rig/SKILL.md) for setup or repair.
- **Network and host routing:** load the locally installed `panda-host`, `tailnet-topology`, and operator-network guidance. Those private/operator resources are not canonical content of this public repo; do not copy them here or expose their topology.

## Guardrails

- Keep actual host routing, auth, and other fleet details in the local private manifest, never a public repo, issue, or output envelope.
- Treat SSH identity mismatch as actionable until independently explained.
- Do not auto-converge role policy. A Central and a thin satellite should not have the same service or skill surface by default.
- Run satellites first and Central last only after a reviewed mutation plan exists.
- Keep fleet audit output redacted before sharing it outside the operator environment.
