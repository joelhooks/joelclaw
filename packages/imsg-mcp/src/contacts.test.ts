import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, test } from "vitest";
import {
  buildContactsIndex,
  createContactsStore,
  defaultAddressBookPaths,
  normalizeHandle,
  normalizePhone,
} from "./contacts.ts";
import { createImsgExec, FDA_MESSAGE, ImsgError, KILLED_MESSAGE, readTimeoutMessage, toErrorText } from "./imsg-cli.ts";
import { createImsgMcpServer } from "./mcp-server.ts";
import { appleDateToIso, APPLE_EPOCH_OFFSET_S, resolveChatDbPath, toAppleSeconds, topContacts } from "./messages-db.ts";
import { immutableUri, openReadOnly } from "./sqlite-ro.ts";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-imsg.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "imsg-contacts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Fixed "now": 2026-09-13T12:00:00Z
const NOW = Date.parse("2026-09-13T12:00:00Z");
const daysAgoNs = (days: number) => BigInt(toAppleSeconds(NOW - days * 86_400_000)) * 1_000_000_000n;
const daysAgoS = (days: number) => toAppleSeconds(NOW - days * 86_400_000);

function writeAddressBook(path: string, seed: (db: DatabaseSync) => void): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT, ZNICKNAME TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
  `);
  seed(db);
  db.close();
  return path;
}

const bookA = writeAddressBook(join(dir, "Sources", "src-a", "AddressBook-v22.abcddb"), (db) => {
  db.exec(`
    INSERT INTO ZABCDRECORD VALUES (1, 19, 'Alice', 'Smith', 'Acme', 'Ali');
    INSERT INTO ZABCDRECORD VALUES (2, 19, 'Bob', NULL, NULL, NULL);
    INSERT INTO ZABCDRECORD VALUES (3, 19, NULL, NULL, 'Plumbers Inc', NULL);
    INSERT INTO ZABCDRECORD VALUES (4, 19, 'Ghost', 'NoHandles', NULL, NULL);
    INSERT INTO ZABCDRECORD VALUES (5, 20, NULL, NULL, NULL, NULL);
    INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '(817) 555-0100');
    INSERT INTO ZABCDPHONENUMBER VALUES (2, 2, '+44 20 7946 0958');
    INSERT INTO ZABCDPHONENUMBER VALUES (3, 3, '817-555-0199');
    INSERT INTO ZABCDPHONENUMBER VALUES (4, 5, '8175550111');
    INSERT INTO ZABCDEMAILADDRESS VALUES (1, 1, 'Alice.Smith@Example.com');
    INSERT INTO ZABCDEMAILADDRESS VALUES (2, 2, 'bob@example.org');
  `);
});
// Second source repeats Alice (same phone, extra email) to exercise cross-source merging.
const bookB = writeAddressBook(join(dir, "AddressBook-v22.abcddb"), (db) => {
  db.exec(`
    INSERT INTO ZABCDRECORD VALUES (1, 19, 'Alice', 'Smith', NULL, NULL);
    INSERT INTO ZABCDRECORD VALUES (2, 19, 'Carol', 'Jones', NULL, NULL);
    INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '+1 817 555 0100');
    INSERT INTO ZABCDEMAILADDRESS VALUES (1, 1, 'ali@work.example');
    INSERT INTO ZABCDEMAILADDRESS VALUES (2, 2, 'carol@example.com');
  `);
});

function writeChatDb(path: string): string {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, service_name TEXT, style INTEGER, display_name TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INTEGER, date INTEGER, is_from_me INTEGER, text TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES (1, '+18175550100', 'iMessage');
    INSERT INTO handle VALUES (2, '+18175550100', 'SMS');
    INSERT INTO handle VALUES (3, 'bob@example.org', 'iMessage');
    INSERT INTO handle VALUES (4, '+15550000000', 'iMessage');
    INSERT INTO chat VALUES (10, '+18175550100', 'iMessage', 45, NULL);
    INSERT INTO chat VALUES (11, '+18175550100', 'SMS', 45, NULL);
    INSERT INTO chat VALUES (12, 'bob@example.org', 'iMessage', 45, NULL);
    INSERT INTO chat VALUES (13, 'chat9000', 'iMessage', 43, 'Crew');
    INSERT INTO chat_handle_join VALUES (10, 1), (11, 2), (12, 3), (13, 1), (13, 3), (13, 4);
  `);
  const insert = db.prepare("INSERT INTO message (ROWID, handle_id, date, is_from_me) VALUES (?, ?, ?, ?)");
  const join = db.prepare("INSERT INTO chat_message_join VALUES (?, ?)");
  let id = 0;
  const add = (chat: number, handle: number, date: bigint | number, fromMe: number) => {
    id += 1;
    insert.run(id, handle, date, fromMe);
    join.run(chat, id);
  };
  // Alice iMessage: 3 inbound, 2 outbound within 30 days; 1 inbound at 100 days; 1 at 400 days (outside 180).
  add(10, 1, daysAgoNs(1), 0);
  add(10, 1, daysAgoNs(2), 0);
  add(10, 1, daysAgoNs(3), 0);
  add(10, 0, daysAgoNs(4), 1);
  add(10, 0, daysAgoNs(5), 1);
  add(10, 1, daysAgoNs(100), 0);
  add(10, 1, daysAgoNs(400), 0);
  // Alice SMS: 1 outbound stored in *seconds* scale (old row) 10 days ago.
  add(11, 0, daysAgoS(10), 1);
  // Bob: 2 inbound 20 days ago.
  add(12, 3, daysAgoNs(20), 0);
  add(12, 3, daysAgoNs(20), 0);
  // Group: bob sends 5, unknown handle sends 1, me sends 2.
  for (let i = 0; i < 5; i += 1) add(13, 3, daysAgoNs(7), 0);
  add(13, 4, daysAgoNs(6), 0);
  add(13, 0, daysAgoNs(6), 1);
  add(13, 0, daysAgoNs(6), 1);
  db.close();
  return path;
}
const chatDb = writeChatDb(join(dir, "chat.db"));

const store = () => createContactsStore({ paths: [bookA, bookB] });

describe("phone and handle normalization", () => {
  test("US formatting variants collapse to one E.164 number", () => {
    for (const raw of ["(817) 555-0100", "+1 817 555 0100", "8175550100", "1-817-555-0100", "tel:817.555.0100", "817 555 0100 x12"]) {
      expect(normalizePhone(raw)).toBe("+18175550100");
    }
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("22000")).toBe("22000");
    expect(normalizePhone("no digits")).toBeNull();
    expect(normalizeHandle("Alice.Smith@Example.com ")).toBe("alice.smith@example.com");
    expect(normalizeHandle("(817) 555-0100")).toBe("+18175550100");
  });
});

describe("contacts index", () => {
  test("indexes phones and emails across sources and merges duplicate people", () => {
    const index = buildContactsIndex([bookA, bookB]);
    expect(index.sources).toEqual([bookA, bookB]);
    expect(index.errors).toEqual([]);
    const alice = index.byHandle.get("+18175550100");
    expect(alice).toMatchObject({ name: "Alice Smith", organization: "Acme", nickname: "Ali" });
    expect(alice?.emails).toEqual(["alice.smith@example.com", "ali@work.example"]);
    expect(index.byHandle.get("ali@work.example")).toBe(alice);
    expect(index.people.map((p) => p.name)).toEqual(["Alice Smith", "Bob", "Plumbers Inc", "Carol Jones"]);
  });

  test("lookupHandle matches formatting variants and email case; unknown handle is null", () => {
    const s = store();
    for (const h of ["(817) 555-0100", "+1 817 555 0100", "8175550100"]) expect(s.lookupHandle(h)?.name).toBe("Alice Smith");
    expect(s.lookupHandle("ALICE.SMITH@example.COM")?.name).toBe("Alice Smith");
    expect(s.lookupHandle("bob@EXAMPLE.org")?.name).toBe("Bob");
    expect(s.lookupHandle("+15550000000")).toBeNull();
    expect(s.lookupHandle("nobody@example.com")).toBeNull();
    expect(s.lookupHandle("   ")).toBeNull();
  });

  test("searchPeople is a case-insensitive substring over names/org plus exact handle", () => {
    const s = store();
    expect(s.searchPeople("smith").map((p) => p.name)).toEqual(["Alice Smith"]);
    expect(s.searchPeople("ALI").map((p) => p.name)).toEqual(["Alice Smith"]);
    expect(s.searchPeople("plumb").map((p) => p.name)).toEqual(["Plumbers Inc"]);
    expect(s.searchPeople("acme").map((p) => p.name)).toEqual(["Alice Smith"]);
    expect(s.searchPeople("817-555-0100").map((p) => p.name)).toEqual(["Alice Smith"]);
    expect(s.searchPeople("BOB@example.org").map((p) => p.name)).toEqual(["Bob"]);
    expect(s.searchPeople("o", 1)).toHaveLength(1);
    expect(s.searchPeople("zzz")).toEqual([]);
    expect(s.searchPeople("")).toEqual([]);
  });

  test("caches for the ttl and reports unreadable sources as warnings, not failures", () => {
    let clock = 0;
    const s = createContactsStore({ paths: [bookA, join(dir, "missing.abcddb")], ttlMs: 1_000, now: () => clock });
    const first = s.status();
    expect(first.sources).toBe(1);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toMatch(/not found/u);
    clock = 500;
    expect(s.status().builtAt).toBe(first.builtAt);
    clock = 1_000;
    expect(s.status().builtAt).not.toBe(first.builtAt);
    expect(defaultAddressBookPaths(join(dir, "nohome"))).toEqual([]);
    expect(buildContactsIndex([]).errors).toEqual([expect.stringContaining("no AddressBook databases found")]);
  });
});

describe("read-only sqlite access", () => {
  test("opens immutable URIs and classifies failures", () => {
    expect(immutableUri("/a b/c.db")).toBe("file:/a%20b/c.db?immutable=1&mode=ro");
    const db = openReadOnly(chatDb, "Messages database");
    expect(() => db.exec("INSERT INTO handle VALUES (99, 'x', 'y')")).toThrow(/readonly/iu);
    db.close();
    expect(() => openReadOnly(join(dir, "nope.db"), "Messages database")).toThrow(/not found/u);
    const locked = join(dir, "locked.db");
    writeFileSync(locked, "");
    chmodSync(locked, 0o000);
    try {
      openReadOnly(locked, "Messages database");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ImsgError);
      expect((error as ImsgError).failure).toBe("fda");
      expect(toErrorText(error)).toContain(FDA_MESSAGE);
    }
  });
});

describe("top contacts", () => {
  test("date helpers handle both scales", () => {
    expect(toAppleSeconds(APPLE_EPOCH_OFFSET_S * 1000)).toBe(0);
    expect(appleDateToIso(0)).toBe("2001-01-01T00:00:00.000Z");
    expect(appleDateToIso(86_400 * 1_000_000_000)).toBe("2001-01-02T00:00:00.000Z");
    expect(resolveChatDbPath({})).toMatch(/Library\/Messages\/chat\.db$/u);
    expect(resolveChatDbPath({ IMSG_MCP_CHAT_DB: "/x/chat.db" })).toBe("/x/chat.db");
  });

  test("counts per handle in the window with in/out split, excluding groups by default", () => {
    const rows = topContacts(chatDb, store(), { days: 180, limit: 30, includeGroups: false, now: NOW });
    expect(rows.map((r) => r.handle)).toEqual(["+18175550100", "bob@example.org"]);
    expect(rows[0]).toEqual({
      handle: "+18175550100",
      service: "SMS,iMessage",
      person: { name: "Alice Smith" },
      total: 7,
      inbound: 4,
      outbound: 3,
      lastMessageAt: "2026-09-12T12:00:00.000Z",
      chatIds: [10, 11],
    });
    expect(rows[1]).toMatchObject({ person: { name: "Bob" }, total: 2, inbound: 2, outbound: 0, chatIds: [12] });

    const narrow = topContacts(chatDb, store(), { days: 30, limit: 30, includeGroups: false, now: NOW });
    expect(narrow[0]).toMatchObject({ total: 6, inbound: 3, outbound: 3 });
    expect(topContacts(chatDb, store(), { days: 180, limit: 1, includeGroups: false, now: NOW })).toHaveLength(1);
    expect(topContacts(chatDb, store(), { days: 1000, limit: 30, includeGroups: false, now: NOW })[0]?.total).toBe(8);
  });

  test("includeGroups attributes inbound group messages to their sender and reports unknown people as null", () => {
    const rows = topContacts(chatDb, store(), { days: 180, limit: 30, includeGroups: true, now: NOW });
    expect(rows.map((r) => [r.handle, r.total, r.inbound, r.outbound])).toEqual([
      ["+18175550100", 7, 4, 3],
      ["bob@example.org", 7, 7, 0],
      ["+15550000000", 1, 1, 0],
    ]);
    expect(rows[1]?.chatIds).toEqual([12, 13]);
    expect(rows[2]?.person).toBeNull();
  });
});

describe("contacts tools over MCP", () => {
  async function connect() {
    const server = createImsgMcpServer({
      exec: createImsgExec({ bin: FAKE }),
      contacts: store(),
      chatDbPath: chatDb,
      now: () => NOW,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    return { client, close: async () => { await client.close(); await server.close(); } };
  }
  const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
    (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

  test("imsg_contacts takes exactly one of query/handle and returns people", async () => {
    const { client, close } = await connect();
    try {
      const both = await client.callTool({ name: "imsg_contacts", arguments: { query: "a", handle: "b" } });
      expect(both.isError).toBe(true);
      const none = await client.callTool({ name: "imsg_contacts", arguments: {} });
      expect(none.isError).toBe(true);
      const byHandle = await client.callTool({ name: "imsg_contacts", arguments: { handle: "(817) 555-0100" } });
      expect(JSON.parse(text(byHandle))).toEqual({
        ok: true,
        people: [{ name: "Alice Smith", phones: ["+18175550100"], emails: ["alice.smith@example.com", "ali@work.example"], organization: "Acme" }],
        sources: 2,
      });
      const unknown = await client.callTool({ name: "imsg_contacts", arguments: { handle: "+15550000000" } });
      expect(JSON.parse(text(unknown))).toEqual({ ok: true, people: [], sources: 2 });
      const byQuery = await client.callTool({ name: "imsg_contacts", arguments: { query: "o", limit: 2 } });
      expect(JSON.parse(text(byQuery)).people).toHaveLength(2);
      const tooMany = await client.callTool({ name: "imsg_contacts", arguments: { query: "o", limit: 51 } });
      expect(tooMany.isError).toBe(true);
    } finally { await close(); }
  });

  test("imsg_top_contacts applies defaults, caps, and resolves people", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: "imsg_top_contacts", arguments: {} });
      const payload = JSON.parse(text(result));
      expect(payload.days).toBe(180);
      expect(payload.contacts.map((r: { handle: string; total: number }) => [r.handle, r.total])).toEqual([["+18175550100", 7], ["bob@example.org", 2]]);
      expect(payload.contacts[0].person).toEqual({ name: "Alice Smith" });
      const groups = await client.callTool({ name: "imsg_top_contacts", arguments: { days: 30, limit: 1, includeGroups: true } });
      expect(JSON.parse(text(groups)).contacts).toHaveLength(1);
      const tooLong = await client.callTool({ name: "imsg_top_contacts", arguments: { days: 3651 } });
      expect(tooLong.isError).toBe(true);
      const missing = createImsgMcpServer({ exec: createImsgExec({ bin: FAKE }), contacts: store(), chatDbPath: join(dir, "gone.db") });
      const c2 = new Client({ name: "test", version: "0.0.0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await missing.connect(a);
      await c2.connect(b);
      const failed = await c2.callTool({ name: "imsg_top_contacts", arguments: {} });
      expect(failed.isError).toBe(true);
      expect(text(failed)).toMatch(/Messages database not found/u);
      await c2.close();
      await missing.close();
    } finally { await close(); }
  });

  test("killed read tools get the timeout hint; killed sends keep the unknown-outcome text", async () => {
    expect(readTimeoutMessage(60_000)).toBe("imsg timed out after 60s; reduce limit or narrow the window");
    const killed = new ImsgError("SIGTERM", null, "killed");
    expect(toErrorText(killed, { kind: "read", timeoutMs: 60_000 })).toContain("imsg timed out after 60s");
    expect(toErrorText(killed, { kind: "read", timeoutMs: 60_000 })).not.toContain(KILLED_MESSAGE);
    expect(toErrorText(killed, { kind: "send" })).toContain(KILLED_MESSAGE);
    expect(toErrorText(killed)).toContain(KILLED_MESSAGE);

    process.env.FAKE_IMSG_MODE = "hang";
    const real = createImsgExec({ bin: FAKE });
    const timeouts: Array<number | undefined> = [];
    const server = createImsgMcpServer({
      exec: (args, options) => {
        timeouts.push(options?.timeoutMs);
        return real(args, { ...options, timeoutMs: 200 });
      },
      contacts: store(),
      chatDbPath: chatDb,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const chats = await client.callTool({ name: "imsg_chats", arguments: { limit: 200 } });
      expect(chats.isError).toBe(true);
      expect(text(chats)).toContain("imsg timed out after 60s; reduce limit or narrow the window");
      expect(text(chats)).not.toContain(KILLED_MESSAGE);
      expect(timeouts[0]).toBe(60_000);
      const status = await client.callTool({ name: "imsg_status", arguments: {} });
      expect(JSON.parse(text(status)).error).toContain("imsg timed out after 60s");
      const over = await client.callTool({ name: "imsg_chats", arguments: { limit: 201 } });
      expect(over.isError).toBe(true);
      expect(text(over)).not.toContain("timed out");
    } finally {
      delete process.env.FAKE_IMSG_MODE;
      await client.close();
      await server.close();
    }
  });
});
