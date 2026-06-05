---
name: pi-extension-authoring
displayName: Pi Extension Authoring
description: "Build, debug, and maintain Pi extensions safely. Use when editing ~/.pi/agent/extensions, joelclaw/pi/extensions, pi-tools extensions, or any code that uses the Pi ExtensionAPI, hooks, tools, commands, widgets, session replacement, reload, custom messages, or extension package updates."
version: 0.1.0
author: Joel Hooks
tags:
  - pi
  - extensions
  - tooling
  - reliability
---

# Pi Extension Authoring

Use this before changing Pi extension code or debugging Pi startup warnings.

## Canonical surfaces

- Repo-local joelclaw extensions: `~/Code/joelhooks/joelclaw/pi/extensions/<name>`
- Active symlinks: `~/.pi/agent/extensions/<name>` → repo-local source
- Package extensions: `~/.pi/agent/git/github.com/<owner>/<repo>`
- Package config: `~/.pi/agent/settings.json`
- Pi SDK/docs: global package under `~/.local/share/fnm/node-versions/*/installation/lib/node_modules/@earendil-works/pi-coding-agent/` (older installs used `@mariozechner/pi-coding-agent`)

## Rules

1. **Do not keep using captured session-bound objects after session replacement.**
   - `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, and `ctx.reload()` invalidate old `pi` and `ctx` objects.
   - For replacement commands, move post-switch work into the method's `withSession` callback and use only the callback `ctx`.
   - For reload commands, treat `await ctx.reload(); return;` as terminal.

2. **Do not call `pi.sendMessage()` from delayed `session_start` callbacks.**
   - A timer, promise, or subprocess can finish after reload/session replacement and throw stale-context errors.
   - Start async work without storing `pi`/ctx, cache the plain result, then inject through `before_agent_start` by returning `{ message }`.
   - Keep any first-turn wait tiny; use a short `Promise.race` budget if the result may not be ready.

3. **Use `pi.registerTool()`, not old APIs.**
   - `pi.addTool()` is gone.
   - Tool results need cloneable `details`. No timers, functions, sockets, or class instances.

4. **Optional dependencies must be lazy.**
   - No top-level imports for optional packages.
   - Use dynamic import or `createRequire()` inside guarded functions.
   - Missing optional dependencies should disable that feature, not crash Pi startup.

5. **One active copy per extension.**
   - Duplicate extension paths cause double hooks, duplicate messages, and weird cost/trace behavior.
   - If a package checkout still contains an old extension directory, make sure its `package.json` no longer lists it in `pi.extensions` before ignoring it.

## Session-safe hidden message pattern

```ts
let cachedMessage: HiddenCustomMessage | null | undefined;
let messagePromise: Promise<HiddenCustomMessage | null> | null = null;
let delivered = false;

pi.on("session_start", (_event, ctx) => {
  delivered = false;
  cachedMessage = undefined;
  const sessionId = ctx.sessionManager?.getSessionId?.() ?? null;
  messagePromise = buildMessageWithoutCapturedPi(sessionId).then((message) => {
    cachedMessage = message;
    return message;
  });
});

pi.on("before_agent_start", async (event) => {
  const message = await Promise.race([
    messagePromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
  ]);

  if (message && !delivered) {
    delivered = true;
    return {
      systemPrompt: event.systemPrompt,
      message,
    };
  }

  return { systemPrompt: event.systemPrompt };
});
```

## Validation

Run the cheap gates first:

```bash
bun --check path/to/extension/index.ts
PI_OFFLINE=1 pi --help >/tmp/pi-help.out 2>/tmp/pi-help.err
rg -n "Skill conflicts|cannot load optional dependency|stale after session|<extension-name>" /tmp/pi-help.err /tmp/pi-help.out
```

For package updates:

```bash
# Update Pi plus settings-managed packages. Current Pi self-update migrates
# @mariozechner/pi-coding-agent installs to @earendil-works/pi-coding-agent.
pi update

# Keep npm-global tools current. Do not install the unrelated `pi` npm package.
npm install -g @earendil-works/pi-coding-agent@latest pi-mcp-adapter@latest pi-gitnexus@latest pi-subagents@latest pi-interactive-shell@latest

# If Bun's shadow global is present, either point ~/.bun/bin/pi at ~/.local/bin/pi
# or force the exact current version. Bun may block fresh releases via minimum-release-age.
bun add -g --minimum-release-age=0 @earendil-works/pi-coding-agent@$(pi --version)

which -a pi
pi --version
pi list
npm list -g --depth=0 | rg '@earendil-works/pi-coding-agent|@mariozechner/pi-coding-agent|pi-gitnexus|pi-mcp-adapter|pi-subagents|pi-interactive-shell'
```

Smoke-test both base Pi and full extension/tool startup with an approved model:

```bash
pi -p --no-session --no-tools --no-extensions --no-context-files --model openai-codex/gpt-5.5 "Reply with exactly OK."
pi -p --no-session --no-context-files --model openai-codex/gpt-5.5 "Reply with exactly OK."
```

Clean untracked npm lockfiles generated inside git package checkouts when the package does not track them.

If multiple `pi` binaries exist, verify they resolve to the same version. On Panda, `~/.bun/bin/pi` should be a symlink to `~/.local/bin/pi`; Bun's global installer can lag behind npm because of `minimum-release-age`.

## Common fixes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `This extension ctx is stale after session replacement or reload` | Delayed callback used old `pi`/ctx | Cache plain data; inject via `before_agent_start` return or use `withSession` |
| `cannot load optional dependency` | Package not installed from extension realpath | Install deps from the source repo realpath or make the dependency lazy/fail-open |
| Duplicate startup messages/traces | Extension loaded twice via package + symlink | Remove one active path from settings/package `pi.extensions` |
| Skill conflict warning | Skill directory name differs from frontmatter `name` | Rename directory or frontmatter so they match |
