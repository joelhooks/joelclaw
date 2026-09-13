# @joelclaw/imsg-mcp

Local HTTP MCP server that wraps the `imsg` CLI so Executor can read and send iMessages on this Mac.
Each tool call spawns `imsg <subcommand> … --json` (no shell, no long-lived child), parses the NDJSON, and returns structured JSON.

## Tools

| Tool | imsg command | Notes |
| --- | --- | --- |
| `imsg_status` | `chats --limit 1` | `{ok:true}` or a plain permission error |
| `imsg_chats` | `chats --limit N [--unread-only]` | rows use `id` as the chat rowid |
| `imsg_group` | `group --chat-id` | identity and participants |
| `imsg_history` | `history --chat-id --limit [--start --end --attachments]` | default 20, max 200, text over 4000 chars truncated |
| `imsg_send` | `send --chat-id|--to --text [--file]` | caller must get explicit user approval first; attachment must be a regular file under `/Users/joel/.joelclaw/imsg-outbox` or `/tmp`; `to`/`text` may not start with `-`; 120s timeout, no abort |

`imsg` v0.15.4 has no `search` subcommand, so there is no `imsg_search`.

## Run

```sh
node src/http-server.ts
```

- Binds `127.0.0.1` only. Non-local `Host` headers get 421.
- `POST /mcp` needs `Authorization: Bearer <token>` (min 32 bytes, timing-safe compare) and `Accept: application/json, text/event-stream`.
- `GET /healthz` is unauthenticated: `{"status":"ok","imsg":"0.15.4"}` (`imsg` is `null` if the binary is missing).

| Env | Default | Purpose |
| --- | --- | --- |
| `IMSG_MCP_PORT` | `4793` | listen port |
| `IMSG_MCP_BIN` | `/opt/homebrew/bin/imsg` | imsg binary |
| `IMSG_MCP_TOKEN` | unset | bearer token; when unset the server leases `imsg_mcp_bearer_token` for 24h via `secrets` (3 retries, 2s/4s/8s backoff) |
| `IMSG_MCP_SECRETS_BIN` | `/Users/joel/.local/bin/secrets` | secrets CLI used for the lease |

The token is never logged and never written to the plist.

## Full Disk Access

`imsg` reads `~/Library/Messages/chat.db`, which needs Full Disk Access. macOS attributes FDA to the launchd job's main executable, so the service runs a pinned, signed copy of node inside `/Applications/imsg-mcp.app` and the `imsg` child inherits the grant.

1. `scripts/install-app-bundle.sh` copies node into `/Applications/imsg-mcp.app/Contents/MacOS/node` and codesigns it with the hardened runtime plus `scripts/imsg-mcp.entitlements` (allow-jit, allow-unsigned-executable-memory, disable-library-validation; V8 aborts without them). Override identity with `IMSG_MCP_SIGN_IDENTITY`, node with `NODE_BIN`. Rerun after node upgrades.
2. System Settings → Privacy & Security → Full Disk Access → add `/Applications/imsg-mcp.app`.
3. `scripts/install-launch-agent.sh install` writes `~/Library/LaunchAgents/com.joel.imsg-mcp.plist`, bootstraps it, waits for `/healthz`, and rolls back on failure. Logs: `~/.joelclaw/logs/imsg-mcp.log` and `.error.log`. `uninstall` removes it.

Sending uses AppleScript via Messages.app; the first send may prompt for Automation permission for the same app bundle. An Automation denial is reported as a separate error naming System Settings › Privacy & Security › Automation, not as an FDA problem. If imsg is killed mid-send (timeout), the tool returns "send outcome unknown; check Messages.app before retrying".

Read tools attach a `warnings` array when imsg prints non-JSON lines on stdout; a call fails only when no JSON row parsed at all.

## Executor registration

Register a Streamable HTTP MCP connection at `http://127.0.0.1:4793/mcp` with header `Authorization: Bearer <token>` where the token is `secrets lease imsg_mcp_bearer_token --ttl 24h`. Call `imsg_status` first; a failure names the missing FDA grant.

## Tests

```sh
pnpm --filter @joelclaw/imsg-mcp test
```

Tests run against `src/__fixtures__/fake-imsg.sh`; no Messages access is needed.
