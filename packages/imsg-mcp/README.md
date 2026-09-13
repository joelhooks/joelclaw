# @joelclaw/imsg-mcp

Local HTTP MCP server that wraps the `imsg` CLI so Executor can read and send iMessages on this Mac.
Each imsg-backed tool call spawns `imsg <subcommand> … --json` (no shell, no long-lived child), parses the NDJSON, and returns structured JSON.
Two contacts tools read Apple's SQLite databases directly (read-only, see below) instead of spawning `imsg`.

## Tools

| Tool | imsg command | Notes |
| --- | --- | --- |
| `imsg_status` | `chats --limit 1` | `{ok:true}` or a plain permission error |
| `imsg_chats` | `chats --limit N [--unread-only]` | rows use `id` as the chat rowid; default 20, max 200 (400 exceeded the timeout on a 760 MB chat.db) |
| `imsg_group` | `group --chat-id` | identity and participants |
| `imsg_history` | `history --chat-id --limit [--start --end --attachments]` | default 20, max 200, text over 4000 chars truncated |
| `imsg_send` | `send --chat-id|--to --text [--file]` | caller must get explicit user approval first; attachment must be a regular file under `/Users/joel/.joelclaw/imsg-outbox` or `/tmp`; `to`/`text` may not start with `-`; 120s timeout, no abort |

| `imsg_contacts` | none (AddressBook SQLite) | `{query}` or `{handle}` (exactly one), `limit` default 10 max 50; returns `people[{name, phones (E.164), emails, organization}]`, empty list when nothing matches |
| `imsg_top_contacts` | none (chat.db SQLite) | `days` default 180 max 3650, `limit` default 30 max 200, `includeGroups` default false; rows `{handle, service, person:{name}|null, total, inbound, outbound, lastMessageAt, chatIds}` sorted by total desc |

`imsg` v0.15.4 has no `search` subcommand, so there is no `imsg_search`.

Read tools (`imsg_status`, `imsg_chats`, `imsg_group`, `imsg_history`) kill `imsg` after 60s and report "imsg timed out after 60s; reduce limit or narrow the window". Only `imsg_send` reports the send-outcome-unknown text.

## Contacts and top contacts (direct SQLite, read-only)

`imsg_contacts` reads every `~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb` plus the top-level `AddressBook-v22.abcddb` when present. Tables used: `ZABCDRECORD` (`Z_PK`, `ZFIRSTNAME`, `ZLASTNAME`, `ZORGANIZATION`, `ZNICKNAME`), `ZABCDPHONENUMBER` (`ZOWNER`, `ZFULLNUMBER`), `ZABCDEMAILADDRESS` (`ZOWNER`, `ZADDRESS`). Records with no phone/email or no name-ish field are skipped. The in-memory index (normalized phone or lowercase email → person) is cached for 5 minutes; the same person in several sources is merged when they share a handle. Phones normalize to E.164 with US as the default country: `(817) 555-0100`, `+1 817 555 0100`, and `8175550100` all become `+18175550100`; a leading `+` is kept as-is. `query` is a case-insensitive substring over first/last/nickname/organization, or an exact phone/email. A source that cannot be opened is reported in `warnings`, not as a failure.

`imsg_top_contacts` runs one aggregate query on `~/Library/Messages/chat.db` (override with `IMSG_MCP_CHAT_DB`): `message` (`ROWID`, `handle_id`, `date`, `is_from_me`) → `chat_message_join` → `chat` (`ROWID`, `style`) → `chat_handle_join` → `handle` (`ROWID`, `id`, `service`). `message.date` is Apple seconds-since-2001 in nanoseconds (old rows in seconds; both scales are handled). Group chats are `chat.style = 43`; they are excluded unless `includeGroups`, in which case inbound group messages count toward their sender (`message.handle_id`) and outbound ones are skipped (Messages stores `handle_id = 0` for them). Direct chats attribute every message, both directions, to the chat's handle. The same handle on iMessage and SMS is merged into one row with `service` = `"SMS,iMessage"`. Each handle is resolved through the contacts index; unknown handles get `person: null`.

Both databases are opened with `node:sqlite` `DatabaseSync` in `readOnly` mode through a `file:…?immutable=1&mode=ro` URI, so no lock is taken and no journal/WAL is touched. Consequence: rows still sitting in `chat.db-wal` and not yet checkpointed are invisible until Messages checkpoints. Nothing is ever written to an Apple database. A database that exists but cannot be opened is reported as the Full Disk Access error; a missing file is a plain "not found". The query runs synchronously; MCP cancellation cannot interrupt it.

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
| `IMSG_MCP_CHAT_DB` | `~/Library/Messages/chat.db` | Messages database read by `imsg_top_contacts` |

The token is never logged and never written to the plist.

## Full Disk Access

`imsg`, `imsg_top_contacts` (chat.db), and `imsg_contacts` (AddressBook) all read under `~/Library`, which needs Full Disk Access. macOS attributes FDA to the launchd job's main executable, so the service runs a pinned, signed copy of node inside `/Applications/imsg-mcp.app` and the `imsg` child inherits the grant.

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

Tests run against `src/__fixtures__/fake-imsg.sh` plus fixture AddressBook and chat.db SQLite files built in a temp dir; no Messages or Contacts access is needed.
