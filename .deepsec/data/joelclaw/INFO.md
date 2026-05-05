# joelclaw

## What this codebase does

Personal AI infrastructure monorepo: Next.js public site, Effect/Bun CLI, gateway daemon, 110+ Inngest functions, Restate workload rig, Redis/Typesense-backed message and memory systems, k8s manifests, and agent skills. The system receives external events from Telegram/Slack/email/webhooks, routes them through durable workers, invokes local/remote agents, writes to Vault/NAS/Typesense, and can mutate local repos and infrastructure.

## Auth shape

- `joelclaw secrets` / agent-secrets is the canonical credential path; secrets should not appear in Vault, repo files, logs, OTEL metadata, or prompts.
- Webhook/auth boundaries are mostly route-local: Next route handlers, system-bus webhook providers, Telegram/Slack channel adapters, and `REVALIDATION_SECRET`-guarded revalidation.
- `packages/system-bus/src/lib/inference.ts` is the only allowed LLM invocation surface inside system-bus; it shells to `pi -p` via inference-router policy and emits OTEL/Langfuse.
- Gateway context is injected by Inngest middleware; functions call `gateway.progress`, `gateway.notify`, and `gateway.alert` instead of importing relay internals directly.
- CLI commands return HATEOAS JSON envelopes via `respond`; privileged commands should lazy-load dependencies and use explicit adapters rather than cross-package relative imports.

## Threat model

Highest impact is exfiltration of environment variables, provider tokens, Telegram/Slack/email credentials, Vault/NAS content, or agent auth through webhooks, logs, prompts, shell execution, or AI tool output. Next is unauthorized external triggering of Inngest/webhook functions that cause agent work, notifications, repo mutations, deploys, or expensive model calls. Treat all inbound channel content, email bodies, Slack text, webhook payloads, URLs, and discovered documents as attacker-controlled until verified.

## Project-specific patterns to flag

- Inngest `serve()` endpoints or Next route handlers exporting unexpected methods, especially `PATCH`, `OPTIONS`, or `DELETE`, after the Inngest SDK env-exfiltration CVE.
- Any direct use of provider LLM APIs, OpenRouter, `auth.json`, or paid API keys in system-bus instead of the shared `infer()` utility.
- Shell execution that interpolates event payloads, URLs, repo names, filenames, Slack/Telegram text, or model output without strict allowlisting/quoting.
- Webhook verification that parses JSON before raw-body signature checks, trims secrets inconsistently, logs headers/bodies, or accepts unsigned provider events.
- Relay code that treats Slack/email/system digests as Joel-authored operator commands, or forwards meta-system chatter/secrets to Telegram.

## Known false-positives

- `skills/`, docs, ADRs, examples, and Vault-synced notes intentionally contain prompts, shell snippets, fake secrets, and security examples; they are not necessarily executable code.
- `.deepsec/`, `.repo-autopsy/`, generated reports, lockfiles, and fixture/sample apps should not be treated as production runtime surfaces.
- Localhost/Tailscale/k8s service URLs in docs and manifests are expected operator infrastructure, not public endpoints by themselves.
- `apps/web/app/api/revalidate/route.ts` intentionally accepts a shared secret in the JSON body; flag only if the secret is logged, optional, or reused elsewhere.
- Test fixtures, demo scripts, and historical migration/backfill utilities may use broad local filesystem access; prioritize paths under `apps/`, `packages/system-bus/`, `packages/gateway/`, `packages/cli/`, and `k8s/`.
