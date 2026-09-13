import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test } from "vitest";
import { AUTOMATION_MESSAGE, createImsgExec, FDA_MESSAGE, KILLED_MESSAGE, TRUNCATION_MARKER } from "./imsg-cli.ts";
import { ATTACHMENT_DIRS, createImsgMcpServer, SEND_TIMEOUT_MS, validateAttachment } from "./mcp-server.ts";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-imsg.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "imsg-mcp-"));
const argsFile = join(dir, "args");
process.env.FAKE_IMSG_ARGS_FILE = argsFile;
// /tmp is an allowed attachment dir; on macOS tmpdir() is under /var/folders, so make our own.
const outbox = mkdtempSync("/tmp/imsg-mcp-outbox-");
const picture = join(outbox, "pic.jpg");
writeFileSync(picture, "jpeg-bytes");
const link = join(outbox, "link.jpg");
symlinkSync(picture, link);
const nested = join(outbox, "sub");
mkdirSync(nested);
writeFileSync(join(nested, "deep.txt"), "x");
const outside = join(dir, "outside.txt");
writeFileSync(outside, "outside");

afterEach(() => {
  delete process.env.FAKE_IMSG_MODE;
});

async function connect() {
  const server = createImsgMcpServer({ exec: createImsgExec({ bin: FAKE }) });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const lastArgs = () => readFileSync(argsFile, "utf8").trimEnd().split("\n");
const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

describe("imsg MCP server", () => {
  test("lists the five tools with send flagged non-read-only", async () => {
    const { client, close } = await connect();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual([
        "imsg_status", "imsg_chats", "imsg_group", "imsg_history", "imsg_send",
      ]);
      const send = listed.tools.find((t) => t.name === "imsg_send");
      expect(send?.annotations?.readOnlyHint).toBe(false);
      expect(send?.description).toMatch(/explicit user approval/u);
      for (const t of listed.tools) if (t.name !== "imsg_send") expect(t.annotations?.readOnlyHint).toBe(true);
    } finally { await close(); }
  });

  test("status ok and chats/group/history spawn the right argv", async () => {
    const { client, close } = await connect();
    try {
      const status = await client.callTool({ name: "imsg_status", arguments: {} });
      expect(JSON.parse(text(status))).toEqual({ ok: true, sampleChats: 2 });
      expect(lastArgs()).toEqual(["chats", "--limit", "1", "--json"]);

      await client.callTool({ name: "imsg_chats", arguments: { limit: 5, unreadOnly: true } });
      expect(lastArgs()).toEqual(["chats", "--limit", "5", "--unread-only", "--json"]);

      const group = await client.callTool({ name: "imsg_group", arguments: { chatId: 42 } });
      expect(JSON.parse(text(group)).chat_id).toBe(42);
      expect(lastArgs()).toEqual(["group", "--chat-id", "42", "--json"]);

      const history = await client.callTool({
        name: "imsg_history",
        arguments: { chatId: 42, start: "2026-01-01T00:00:00Z", attachments: true },
      });
      expect(lastArgs()).toEqual([
        "history", "--chat-id", "42", "--limit", "20", "--start", "2026-01-01T00:00:00Z", "--attachments", "--json",
      ]);
      const messages = JSON.parse(text(history)).messages as Array<{ text: string }>;
      expect(messages).toHaveLength(2);
      expect(messages[1]?.text.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(messages[1]?.text.length).toBe(4_000 + TRUNCATION_MARKER.length);
    } finally { await close(); }
  });

  test("history limit is capped by schema", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: "imsg_history", arguments: { chatId: 1, limit: 201 } });
      expect(result.isError).toBe(true);
    } finally { await close(); }
  });

  test("send requires exactly one target and passes text/file", async () => {
    const { client, close } = await connect();
    try {
      const both = await client.callTool({ name: "imsg_send", arguments: { chatId: 1, to: "+1", text: "hi" } });
      expect(both.isError).toBe(true);
      const none = await client.callTool({ name: "imsg_send", arguments: { chatId: 1 } });
      expect(none.isError).toBe(true);
      const rel = await client.callTool({ name: "imsg_send", arguments: { chatId: 1, attachment: "pic.jpg" } });
      expect(rel.isError).toBe(true);

      const sent = await client.callTool({
        name: "imsg_send",
        arguments: { to: "+15551234567", text: "hi there", attachment: picture },
      });
      expect(sent.isError).toBeFalsy();
      expect(JSON.parse(text(sent))).toEqual({ sent: true, result: { success: true, chat_id: 42, guid: "sent-1" } });
      expect(lastArgs()).toEqual(["send", "--to", "+15551234567", "--text", "hi there", "--file", picture, "--json"]);
    } finally { await close(); }
  });

  test("attachment must be a regular file inside an allowed dir", async () => {
    expect(ATTACHMENT_DIRS).toEqual(["/Users/joel/.joelclaw/imsg-outbox", "/tmp"]);
    expect(validateAttachment(picture)).toBe(picture);
    expect(validateAttachment(join(nested, "deep.txt"))).toBe(join(nested, "deep.txt"));
    expect(() => validateAttachment(join(outbox, "missing.jpg"))).toThrow(/does not exist.*imsg-outbox or \/tmp/u);
    expect(() => validateAttachment(link)).toThrow(/regular file/u);
    expect(() => validateAttachment(outbox)).toThrow(/regular file/u);
    expect(() => validateAttachment(outside)).toThrow(/must live under \/Users\/joel\/.joelclaw\/imsg-outbox or \/tmp/u);
    expect(() => validateAttachment("/etc/hosts")).toThrow(/must live under/u);
    expect(() => validateAttachment(`/tmp/../${outside.slice(1)}`)).toThrow(/must live under/u);
    expect(() => validateAttachment("-rf")).toThrow(/must not start with "-"/u);

    const { client, close } = await connect();
    try {
      const bad = await client.callTool({ name: "imsg_send", arguments: { chatId: 1, attachment: outside } });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toContain("/Users/joel/.joelclaw/imsg-outbox or /tmp");
      const sym = await client.callTool({ name: "imsg_send", arguments: { chatId: 1, attachment: link } });
      expect(sym.isError).toBe(true);
    } finally { await close(); }
  });

  test("send rejects leading-dash to/text and history validates ISO dates", async () => {
    const { client, close } = await connect();
    try {
      const to = await client.callTool({ name: "imsg_send", arguments: { to: "--db", text: "hi" } });
      expect(to.isError).toBe(true);
      expect(text(to)).toContain('to must not start with "-"');
      const body = await client.callTool({ name: "imsg_send", arguments: { chatId: 1, text: "-rf everything" } });
      expect(body.isError).toBe(true);
      expect(text(body)).toContain("prefix a space or rephrase");
      const okBody = await client.callTool({ name: "imsg_send", arguments: { chatId: 1, text: " -rf everything" } });
      expect(okBody.isError).toBeFalsy();
      expect(lastArgs()).toEqual(["send", "--chat-id", "1", "--text", " -rf everything", "--json"]);

      const badStart = await client.callTool({ name: "imsg_history", arguments: { chatId: 1, start: "--db" } });
      expect(badStart.isError).toBe(true);
      const badEnd = await client.callTool({ name: "imsg_history", arguments: { chatId: 1, end: "yesterday" } });
      expect(badEnd.isError).toBe(true);
      const good = await client.callTool({
        name: "imsg_history",
        arguments: { chatId: 1, start: "2026-01-01", end: "2026-02-01T00:00:00+02:00" },
      });
      expect(good.isError).toBeFalsy();
    } finally { await close(); }
  });

  test("send uses the long timeout, no abort signal, and reports killed children", async () => {
    const calls: Array<{ args: readonly string[]; options: { signal?: AbortSignal; timeoutMs?: number } | undefined }> = [];
    const real = createImsgExec({ bin: FAKE });
    const server = createImsgMcpServer({
      exec: (args, options) => {
        calls.push({ args, options });
        return real(args, options);
      },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      await client.callTool({ name: "imsg_send", arguments: { chatId: 1, text: "hi" } });
      const send = calls.find((c) => c.args[0] === "send");
      expect(send?.options?.timeoutMs).toBe(SEND_TIMEOUT_MS);
      expect(send?.options?.signal).toBeUndefined();
      await client.callTool({ name: "imsg_chats", arguments: {} });
      const chats = calls.find((c) => c.args[0] === "chats");
      expect(chats?.options?.signal).toBeInstanceOf(AbortSignal);
    } finally { await client.close(); await server.close(); }

    process.env.FAKE_IMSG_MODE = "hang";
    const short = createImsgMcpServer({ exec: (args, options) => real(args, { ...options, timeoutMs: 200 }) });
    const client2 = new Client({ name: "test", version: "0.0.0" });
    const [c, d] = InMemoryTransport.createLinkedPair();
    await short.connect(c);
    await client2.connect(d);
    try {
      const killed = await client2.callTool({ name: "imsg_send", arguments: { chatId: 1, text: "hi" } });
      expect(killed.isError).toBe(true);
      expect(text(killed)).toContain(KILLED_MESSAGE);
    } finally { await client2.close(); await short.close(); }
  });

  test("automation failures on send name the Automation grant, not FDA", async () => {
    process.env.FAKE_IMSG_MODE = "automation";
    const { client, close } = await connect();
    try {
      const sent = await client.callTool({ name: "imsg_send", arguments: { chatId: 1, text: "hi" } });
      expect(sent.isError).toBe(true);
      expect(text(sent)).toContain(AUTOMATION_MESSAGE);
      expect(text(sent)).not.toContain(FDA_MESSAGE);
    } finally { await close(); }
  });

  test("non-JSON stdout lines surface as warnings on read tools", async () => {
    process.env.FAKE_IMSG_MODE = "noisy";
    const { client, close } = await connect();
    try {
      const chats = await client.callTool({ name: "imsg_chats", arguments: {} });
      expect(chats.isError).toBeFalsy();
      const payload = JSON.parse(text(chats));
      expect(payload.chats).toHaveLength(2);
      expect(payload.warnings).toEqual(["imsg emitted a non-JSON line: note: this is not json"]);
      const status = await client.callTool({ name: "imsg_status", arguments: {} });
      expect(JSON.parse(text(status))).toMatchObject({ ok: true, sampleChats: 2, warnings: [expect.any(String)] });
    } finally { await close(); }
  });

  test("permission failures become plain FDA tool errors", async () => {
    process.env.FAKE_IMSG_MODE = "denied";
    const { client, close } = await connect();
    try {
      const chats = await client.callTool({ name: "imsg_chats", arguments: {} });
      expect(chats.isError).toBe(true);
      expect(text(chats)).toContain(FDA_MESSAGE);
      expect(text(chats)).toContain("authorization denied");
      const status = await client.callTool({ name: "imsg_status", arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(JSON.parse(text(status))).toMatchObject({ ok: false, error: expect.stringContaining(FDA_MESSAGE) });
    } finally { await close(); }
  });

  test("generic failures surface stderr", async () => {
    process.env.FAKE_IMSG_MODE = "crash";
    const { client, close } = await connect();
    try {
      const chats = await client.callTool({ name: "imsg_chats", arguments: {} });
      expect(chats.isError).toBe(true);
      expect(text(chats)).toContain("boom: something else broke");
      expect(text(chats)).not.toContain(FDA_MESSAGE);
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(outbox, { recursive: true, force: true });
    }
  });
});
