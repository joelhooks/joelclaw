# Agent Loop v2 — Continuation Prompt

Paste this into a fresh session to continue the work.

---

## Context

We just implemented ADR-0005 (durable multi-agent coding loops via Inngest) in `~/Code/system-bus`. The system works — 4 Inngest functions (PLANNER→IMPLEMENTOR→REVIEWER→JUDGE) chain via events, spawning codex/claude/pi as subprocesses. Smoke tested end-to-end successfully.

Now we need to implement ADR-0007 (v2 improvements). The PRD is ready.

## Key files to read first

1. **ADR-0007 (the spec)**: `~/Vault/docs/decisions/0007-agent-loop-v2-improvements.md`
2. **PRD with 8 stories**: `~/Code/system-bus/prd-v2.json`
3. **Progress log**: `~/Code/system-bus/progress.txt` (has codebase patterns from v1 build)
4. **Existing implementation**:
   - Event types: `~/Code/system-bus/src/inngest/client.ts`
   - Shared utils: `~/Code/system-bus/src/inngest/functions/agent-loop/utils.ts`
   - PLANNER: `~/Code/system-bus/src/inngest/functions/agent-loop/plan.ts`
   - IMPLEMENTOR: `~/Code/system-bus/src/inngest/functions/agent-loop/implement.ts`
   - REVIEWER: `~/Code/system-bus/src/inngest/functions/agent-loop/review.ts`
   - JUDGE: `~/Code/system-bus/src/inngest/functions/agent-loop/judge.ts`
   - serve.ts: `~/Code/system-bus/src/serve.ts`
   - igs CLI (loop subcommands): `~/Code/joelhooks/igs/src/cli.ts`
5. **GitHub App skill**: `~/.pi/agent/skills/github-bot/SKILL.md` (token minting for Docker auth)

## Codebase patterns (from v1 build)

- Bun runtime, NOT Node.js. Use `Bun.$` for shell, `Bun.file` for fs, `bun test` for testing
- Inngest v3 SDK with typed events via `EventSchemas().fromRecord<Events>()`
- Functions use `step.run()` for retryable steps, `inngest.send()` for event emission
- Concurrency keys use CEL expressions (`event.data.project`), NOT `{{ }}` template syntax. `loop` is a reserved word in CEL.
- `codex exec --full-auto` (no `-q` flag)
- `claude -p PROMPT --output-format text`
- Worker on port 3111 via Hono, Inngest server at localhost:8288
- Restart worker after changes: `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`
- Verify registration: `igs functions` should show all 8 functions
- GitHub App token: run `~/.pi/agent/skills/github-bot/scripts/github-token.sh`
- Secrets in agent-secrets: `github_app_id`, `github_app_client_id`, `github_app_installation_id`, `github_app_pem`
- slog for structured logging: `slog write --action ACTION --tool TOOL --detail "what" --reason "why"`

## Bugs fixed in v1 (don't re-introduce)

- `codex exec` doesn't accept `-q` flag
- Inngest concurrency keys are CEL, not Jinja templates
- `loop` is reserved in CEL — don't use it in concurrency key strings
- Judge must `markStorySkipped` to prevent planner re-picking exhausted stories
- Use `Effect.tryPromise` not raw `await` inside Effect generators (igs CLI)

## Task

Read the PRD at `~/Code/system-bus/prd-v2.json`. Implement the stories in priority order (V2-1 through V2-8). After each story:

1. Verify TypeScript compiles: `cd ~/Code/system-bus && bunx tsc --noEmit src/serve.ts src/inngest/client.ts src/inngest/functions/agent-loop/*.ts`
2. Restart worker: `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`
3. Verify functions register: `cd ~/Code/joelhooks/igs && bun run src/cli.ts functions` (should show 8 functions)
4. Update `progress.txt` with what was done and any learnings
5. Mark the story as `passes: true` in `prd-v2.json`
6. `slog write` to log the completion

Keep `progress.txt` updated with codebase patterns as you learn them — this defends against context compaction.

If you hit a blocker, note it in progress.txt and move to the next story. Don't get stuck.
