# JoelClaw

Personal AI infrastructure: event-driven workflows, gateway, CLI, and website. Read relevant project Brain and `VISION.md` when present. Verify runtime placement from current configuration and the owning runbook; historical host diagrams and version tables are not live state.

## Architecture

Keep reusable domain logic in `@joelclaw/*` packages behind interfaces. Gateway and CLI are composition roots. Import across packages by package name, not relative source paths. Put concrete adapter wiring at composition roots.

Use `TelemetryEmitter` from `@joelclaw/telemetry` for structured operational events and the `@joelclaw/inference-router` catalog for runtime model selection. Honor an explicit model request when the runtime supports it. Keep model/provider mappings in configuration, not prompt prose.

System-bus inference uses the existing `lib/inference` entry point. Do not read auth files or introduce another paid inference path as a side effect.

## Task routes

Load the skill for the domain being changed, then its relevant branch references:

| Area | Start here |
| --- | --- |
| Website | `skills/joelclaw-web/SKILL.md` |
| System bus and durable events | `skills/system-bus/SKILL.md` |
| Gateway and channel ownership | `skills/gateway/SKILL.md` |
| Kubernetes | `skills/k8s/SKILL.md` |
| Cross-cutting architecture or event flow | `skills/system-architecture/SKILL.md` |
| Staged workloads | `skills/workflow-rig/SKILL.md` |
| Skills | `skills/skill-review/SKILL.md` |

The CLI is the primary operator interface. Read `joelclaw --help` and command help for the current surface. Keep heavy dependencies lazy-loaded so unrelated commands can start.

## Gateway boundary

Preserve the single gateway and transport owners. Never start a second Telegram poller, Slack socket, Discord listener, or standalone adapter process. Read the current gateway runbook before changing channel ownership or performing cutover. Follow the existing durable inbound queue and correlation contracts.

## Validation

Use repository and package scripts as the command source. Run checks for the affected behavior and complete applicable CI gates. Root scripts include `pnpm check-types`, `pnpm lint`, and `pnpm fmt:check`; scope them when the package supports it. Documentation-only changes need source, metadata, link, and diff checks, not live service probes.

For a push that affects website deployment, check the resulting deployment and fix a failed build before stacking more deployment changes. Report observed status, not an assumed success based on elapsed time. Deployments require task authorization.

## Work and records

Execute a clear request within its scope. Skill workflow preferences do not require repeating permission already given. Ask when a missing consequential decision blocks correctness. Preserve unrelated edits and shared history; stage only this task's changes. Never reset a divergent shared checkout to make publishing easier.

Edit canonical skills in `skills/`; installed links and namespaced packs are consumers. Preserve invocation metadata and provenance. Record durable decisions and operational receipts in Brain, with OTEL for runtime events. Keep private topology, credentials, customer data, and private source material out of public artifacts.

<!-- pi-notes-agent:start -->
## pi-notes Brain workflow

This repo uses pi-notes for durable project memory and local review surfaces.

- Read `BRAIN.md` and relevant `.brain/**/*.svx` notes before substantial planning, architecture claims, or code edits.
- Treat `.brain/` as source. Do not leave important decisions only in chat.
- Author Brain pages as MDSvX `.svx` files.
- Keep `.svx` readable: prose, links, short summaries, and component invocations.
- Put large structured data in `.brain/data/**`.
- Put reusable local renderers in `.brain/components/**/*.svelte`.
- Use the `brain-component-composition` skill before substantial `.brain`, component, or data-backed review work.
- Browser feedback should be handled as a Review Batch with a receipt, not as vague chat commentary.
- Run `pi-notes brain check` after Brain changes and the normal project checks after code changes.
<!-- pi-notes-agent:end -->
