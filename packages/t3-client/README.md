# @joelclaw/t3-client

Headless client for a T3 Code server. The gateway (or any joelclaw code) can
start agent turns, stream what happens, and answer approvals — over T3's typed
WebSocket contract, no browser, no T3 fork.

The Effect v4 machinery stays inside `src/client.ts`. The exported surface is
plain promises, async iterables, and JSON events (`src/events.ts`), so
Effect-3 joelclaw code never touches v4 types. Contracts come from
`@joelclaw/t3-contracts` (vendored; see that package's README).

## Pairing (once per server)

Pairing tokens are single-use; the bearer they buy lasts ~30 days and is
stored at `~/.joelclaw/t3-client.json` (mode 0600, override with
`T3_CLIENT_CREDENTIALS`).

```sh
# on the machine running the T3 server:
#   node apps/server/src/bin.ts pair --base-dir <t3-home>   (prints pair#token=…)
t3c pair 'http://localhost:5733/pair#token=XXXX' --url http://127.0.0.1:13773
```

`--url` is the T3 **server** HTTP base (the `[dev-runner] serverPort`, or the
tailnet URL for a `--tailscale` pairing), not the web app origin in the
pairing URL.

## CLI

```sh
t3c status                    # bearer + session check over HTTP
t3c threads [--json]          # shell snapshot; flags pending APPROVAL/INPUT
t3c start --root /path "fix the failing test"   # streams until turn settles
t3c watch <threadId>
t3c approve <threadId> <requestId> accept       # or acceptForSession|decline|cancel
t3c input <threadId> <requestId> '{"answer":"yes"}'
t3c interrupt <threadId>
```

`start` defaults to `runtimeMode: approval-required` — the gateway is remote
control, so the human stays in the approval loop unless `--mode` says
otherwise. Model selection defaults to the project's default, then the most
recent thread's.

## Library

```ts
import { connectT3, withReconnect } from "@joelclaw/t3-client";
import { loadCredentials } from "@joelclaw/t3-client/credentials";

const session = await connectT3(await loadCredentials());
const { threadId } = await session.startTurn({ workspaceRoot: "/path", prompt: "…" });
for await (const event of session.watchThread(threadId)) {
  // kind: sync | message | activity | attention | turn-settled | event
}
await session.close();
```

`withReconnect(credentials, use)` is the daemon wrapper: reconnects with
capped backoff and hands each live session to `use`.

## Gateway wiring notes

- `attention` events (reason `approval` | `user-input`) are the
  Discord-button hook: relay `summary`, answer with `respondApproval` /
  `respondUserInput` using `requestId`. `approval` comes from the typed
  activity tone; `user-input` is still matched off the provider's activity
  kind, so verify that half against a live prompt. `requestId` is optional —
  fall back to `payload` when it is absent.
- `turn-settled` is always the final event of a watched turn and carries the
  last non-empty assistant text.
- This package does not send anything to Discord itself. Single-owner comms:
  the gateway loop decides what Joel hears.

Proven against T3 contracts 0.0.33 (t3code `beab6886f`), 2026-08-23. The
original spike lives in the t3code checkout at
`apps/server/scratch/gateway-spike.ts` and can be deleted once this package
has a green smoke run.

## Known issues

Deferred, all known and none of them fixed yet:

- `watchThread` throws away the opening snapshot frames, so watching a thread
  whose turn already settled hangs, and a reconnect never learns that an
  approval is already pending.
- The `watchThread` queue is unbounded and starts its fiber at call time, not
  at first iteration, so a slow consumer buys memory growth.
- The 500ms drain before `turn-settled` is a timer, not an acknowledgement;
  a slow final message frame can still land after it.
- `withReconnect` retries forever, including on a fatal auth error that will
  never succeed.
- A brand-new project with no model default silently borrows the model from
  the most recently updated thread in *any* project.
- The vendored-contracts `sync.sh` copies files without smoke-checking that
  the copy still compiles or matches the server it came from.
