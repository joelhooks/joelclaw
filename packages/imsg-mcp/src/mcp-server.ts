import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { createContactsStore, type ContactsStore } from "./contacts.ts";
import {
  createImsgExec,
  READ_TIMEOUT_MS,
  runImsgJson,
  toErrorText,
  truncateMessageTexts,
  type ErrorTextContext,
  type ImsgExec,
  type NdjsonResult,
} from "./imsg-cli.ts";
import { resolveChatDbPath, topContacts } from "./messages-db.ts";

export const SERVER_NAME = "imsg-mcp";
export const SERVER_VERSION = "0.1.0";
const HISTORY_DEFAULT = 20;
const HISTORY_MAX = 200;
const CHATS_DEFAULT = 20;
const CHATS_MAX = 200;
const CONTACTS_DEFAULT = 10;
const CONTACTS_MAX = 50;
const TOP_DAYS_DEFAULT = 180;
const TOP_DAYS_MAX = 3650;
const TOP_LIMIT_DEFAULT = 30;
const TOP_LIMIT_MAX = 200;
export const SEND_TIMEOUT_MS = 120_000;
export const ATTACHMENT_DIRS = ["/Users/joel/.joelclaw/imsg-outbox", "/tmp"] as const;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

export interface ImsgMcpOptions {
  readonly exec?: ImsgExec;
  readonly contacts?: ContactsStore;
  readonly chatDbPath?: string;
  /** Clock for imsg_top_contacts windows (tests). */
  readonly now?: () => number;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const ChatIdSchema = z.number().int().positive().describe("chat rowid from imsg_chats (the `id` field)");
const IsoSchema = z.string().regex(ISO_8601, "must be ISO-8601, e.g. 2025-01-01T00:00:00Z");

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function withWarnings(payload: Record<string, unknown>, result: NdjsonResult): Record<string, unknown> {
  return result.warnings.length === 0 ? payload : { ...payload, warnings: result.warnings };
}

function underDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}${sep}`);
}

/** Resolve an attachment path; the file must be a regular file (not a symlink) inside an allowed dir. */
export function validateAttachment(input: string, dirs: readonly string[] = ATTACHMENT_DIRS): string {
  const allowed = dirs.join(" or ");
  if (input.startsWith("-")) throw new Error(`attachment must not start with "-"; allowed dirs: ${allowed}`);
  if (!input.startsWith("/")) throw new Error(`attachment must be an absolute path under ${allowed}`);
  const path = resolve(input);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`attachment does not exist: ${path}; allowed dirs: ${allowed}`);
  }
  if (!stat.isFile()) throw new Error(`attachment must be a regular file (no symlinks): ${path}; allowed dirs: ${allowed}`);
  const realDir = realpathSync(dirname(path));
  const inside = dirs.some((dir) => {
    let realAllowed = dir;
    try {
      realAllowed = realpathSync(dir);
    } catch {
      return false;
    }
    return underDir(realDir, realAllowed);
  });
  if (!inside) throw new Error(`attachment must live under ${allowed}: ${path}`);
  return path;
}

function fail(error: unknown, context?: ErrorTextContext): CallToolResult {
  return { content: [{ type: "text", text: toErrorText(error, context) }], isError: true };
}

const READ_CONTEXT: ErrorTextContext = { kind: "read", timeoutMs: READ_TIMEOUT_MS };
const READ_OPTIONS = { timeoutMs: READ_TIMEOUT_MS } as const;

async function guarded(work: () => Promise<unknown>, context: ErrorTextContext = READ_CONTEXT): Promise<CallToolResult> {
  try {
    return ok(await work());
  } catch (error) {
    return fail(error, context);
  }
}

export function createImsgMcpServer(options: ImsgMcpOptions = {}): McpServer {
  const exec = options.exec ?? createImsgExec();
  const contacts = options.contacts ?? createContactsStore();
  const chatDbPath = options.chatDbPath ?? resolveChatDbPath();
  const now = options.now ?? Date.now;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "imsg_status",
    {
      title: "iMessage access status",
      description:
        "Check whether this Mac can read the Messages database. Runs `imsg chats --limit 1`. Returns {ok:true} or a plain-language permission error. Call this first if other imsg tools fail.",
      inputSchema: {},
      annotations: READ,
    },
    async (_input, extra) => {
      try {
        const result = await runImsgJson(exec, ["chats", "--limit", "1"], { ...READ_OPTIONS, signal: extra.signal });
        return ok(withWarnings({ ok: true, sampleChats: result.rows.length }, result));
      } catch (error) {
        return ok({ ok: false, error: toErrorText(error, READ_CONTEXT) });
      }
    },
  );

  server.registerTool(
    "imsg_chats",
    {
      title: "List recent iMessage chats",
      description:
        "List recent conversations, newest first. Each row has id (chat rowid), name, display_name, contact_name, identifier, guid, service, last_message_at, is_group, participants, unread_count. Use `id` as chatId for imsg_history, imsg_group, and imsg_send.",
      inputSchema: {
        limit: z.number().int().min(1).max(CHATS_MAX).optional().describe(`Number of chats (default ${CHATS_DEFAULT}).`),
        unreadOnly: z.boolean().optional().describe("Only chats with unread inbound messages."),
      },
      annotations: READ,
    },
    (input, extra) =>
      guarded(async () => {
        const args = ["chats", "--limit", String(input.limit ?? CHATS_DEFAULT)];
        if (input.unreadOnly === true) args.push("--unread-only");
        const result = await runImsgJson(exec, args, { ...READ_OPTIONS, signal: extra.signal });
        return withWarnings({ chats: result.rows }, result);
      }),
  );

  server.registerTool(
    "imsg_group",
    {
      title: "Show chat identity and participants",
      description:
        "Show identifier, guid, display name, service, group flag, and participant handles for one chat rowid. Works for direct chats too.",
      inputSchema: { chatId: ChatIdSchema },
      annotations: READ,
    },
    (input, extra) =>
      guarded(async () => {
        const result = await runImsgJson(exec, ["group", "--chat-id", String(input.chatId)], { ...READ_OPTIONS, signal: extra.signal });
        const { rows } = result;
        if (rows.length === 1 && result.warnings.length === 0) return rows[0];
        return withWarnings({ rows }, result);
      }),
  );

  server.registerTool(
    "imsg_history",
    {
      title: "Read iMessage history for a chat",
      description:
        `Recent messages for one chat rowid, oldest to newest as imsg emits them. Each row has id, guid, sender, sender_name, is_from_me, text, created_at, chat_id, attachments (when attachments=true), reply_to_guid. Message text over 4000 chars is truncated with a marker. Default limit ${HISTORY_DEFAULT}, max ${HISTORY_MAX}.`,
      inputSchema: {
        chatId: ChatIdSchema,
        limit: z.number().int().min(1).max(HISTORY_MAX).optional().describe(`Messages to return (default ${HISTORY_DEFAULT}, max ${HISTORY_MAX}).`),
        start: IsoSchema.optional().describe("ISO8601 start (inclusive), e.g. 2025-01-01T00:00:00Z."),
        end: IsoSchema.optional().describe("ISO8601 end (exclusive)."),
        attachments: z.boolean().optional().describe("Include attachment metadata (filename, mime_type, original_path, total_bytes)."),
      },
      annotations: READ,
    },
    (input, extra) =>
      guarded(async () => {
        const args = ["history", "--chat-id", String(input.chatId), "--limit", String(input.limit ?? HISTORY_DEFAULT)];
        if (input.start !== undefined) args.push("--start", input.start);
        if (input.end !== undefined) args.push("--end", input.end);
        if (input.attachments === true) args.push("--attachments");
        const result = await runImsgJson(exec, args, { ...READ_OPTIONS, signal: extra.signal });
        return withWarnings({ messages: truncateMessageTexts(result.rows) }, result);
      }),
  );

  server.registerTool(
    "imsg_send",
    {
      title: "Send an iMessage",
      description:
        "SEND a message from this Mac's Messages account. This is an outward-facing, irreversible action: the caller MUST obtain explicit user approval for the exact recipient and text before calling. Target one of chatId (rowid from imsg_chats) or to (phone number or email). Provide text and/or an attachment: an absolute path to a regular file under /Users/joel/.joelclaw/imsg-outbox or /tmp. Text must not start with \"-\".",
      inputSchema: {
        chatId: ChatIdSchema.optional(),
        to: z.string().min(1).max(320).optional().describe("Phone number (E.164 preferred) or email handle. Use instead of chatId."),
        text: z.string().min(1).max(20_000).optional().describe("Message body."),
        attachment: z.string().min(1).max(4_096).optional().describe("Absolute path to a regular file under /Users/joel/.joelclaw/imsg-outbox or /tmp."),
        service: z.enum(["imessage", "sms", "auto"]).optional().describe("Service (default auto)."),
      },
      annotations: SEND,
    },
    (input) =>
      guarded(async () => {
        const hasChat = input.chatId !== undefined;
        const hasTo = input.to !== undefined;
        if (hasChat === hasTo) throw new Error("Provide exactly one of chatId or to.");
        if (input.text === undefined && input.attachment === undefined) {
          throw new Error("Provide text, attachment, or both.");
        }
        if (hasTo && (input.to as string).startsWith("-")) {
          throw new Error('to must not start with "-".');
        }
        if (input.text !== undefined && input.text.startsWith("-")) {
          throw new Error('text must not start with "-"; prefix a space or rephrase it.');
        }
        const attachment = input.attachment === undefined ? undefined : validateAttachment(input.attachment);
        const args = ["send"];
        if (hasChat) args.push("--chat-id", String(input.chatId));
        else args.push("--to", input.to as string);
        if (input.text !== undefined) args.push("--text", input.text);
        if (attachment !== undefined) args.push("--file", attachment);
        if (input.service !== undefined) args.push("--service", input.service);
        // No abort signal: killing imsg mid-AppleScript can leave a sent message behind.
        const result = await runImsgJson(exec, args, { timeoutMs: SEND_TIMEOUT_MS });
        const { rows } = result;
        return withWarnings({ sent: true, result: rows.length === 1 ? rows[0] : rows }, result);
      }, { kind: "send" }),
  );

  server.registerTool(
    "imsg_contacts",
    {
      title: "Look up people in Contacts",
      description:
        "Resolve iMessage handles to people using the macOS Contacts (AddressBook) databases, read-only. Pass exactly one of query (case-insensitive substring over first/last/nickname/organization, or an exact phone/email) or handle (a phone number or email; returns the one matching person). Phones are normalized to E.164 (US default). Empty results are not errors.",
      inputSchema: {
        query: z.string().min(1).max(200).optional().describe("Name fragment, organization, or exact phone/email."),
        handle: z.string().min(1).max(320).optional().describe("Phone number or email to resolve to one person."),
        limit: z.number().int().min(1).max(CONTACTS_MAX).optional().describe(`Max people for query (default ${CONTACTS_DEFAULT}, max ${CONTACTS_MAX}).`),
      },
      annotations: READ,
    },
    (input) =>
      guarded(async () => {
        const hasQuery = input.query !== undefined;
        const hasHandle = input.handle !== undefined;
        if (hasQuery === hasHandle) throw new Error("Provide exactly one of query or handle.");
        const people = hasHandle
          ? [contacts.lookupHandle(input.handle as string)].filter((p) => p !== null)
          : contacts.searchPeople(input.query as string, input.limit ?? CONTACTS_DEFAULT);
        const status = contacts.status();
        const payload: Record<string, unknown> = {
          ok: true,
          people: people.map((p) => ({ name: p.name, phones: p.phones, emails: p.emails, organization: p.organization })),
          sources: status.sources,
        };
        if (status.errors.length > 0) payload.warnings = status.errors;
        return payload;
      }),
  );

  server.registerTool(
    "imsg_top_contacts",
    {
      title: "Most-messaged contacts",
      description:
        `Who this Mac messages most: per-handle message counts from ~/Library/Messages/chat.db (opened read-only, immutable) over the last N days, with inbound/outbound split, last activity, chat rowids, and the Contacts person when known. Group chats are excluded unless includeGroups=true (then inbound group messages count toward their sender). Sorted by total desc. Default ${TOP_DAYS_DEFAULT} days, ${TOP_LIMIT_DEFAULT} rows.`,
      inputSchema: {
        days: z.number().int().min(1).max(TOP_DAYS_MAX).optional().describe(`Window in days (default ${TOP_DAYS_DEFAULT}, max ${TOP_DAYS_MAX}).`),
        limit: z.number().int().min(1).max(TOP_LIMIT_MAX).optional().describe(`Rows to return (default ${TOP_LIMIT_DEFAULT}, max ${TOP_LIMIT_MAX}).`),
        includeGroups: z.boolean().optional().describe("Count inbound group-chat messages toward their sender (default false)."),
      },
      annotations: READ,
    },
    (input) =>
      guarded(async () => {
        const days = input.days ?? TOP_DAYS_DEFAULT;
        const rows = topContacts(chatDbPath, contacts, {
          days,
          limit: input.limit ?? TOP_LIMIT_DEFAULT,
          includeGroups: input.includeGroups === true,
          now: now(),
        });
        return { days, contacts: rows };
      }),
  );

  return server;
}
