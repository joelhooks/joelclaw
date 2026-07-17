import { describe, expect, test } from "bun:test";
import { TelegramAdapter } from "@chat-adapter/telegram";
import { prepareTelegramMarkdown } from "./telegram-markdown";

const CURATOR_DM = [
  "**The memory layer caught its own blind spot.** 🧠",
  "",
  "A smol move: read [the receipt](https://example.com/a-(b)) - then decide!",
  "",
  "- keep the paragraphs",
  "- render the bullets",
  "- escape nasty punctuation: . ! - ( )",
].join("\n");

const CURATOR_NORMALIZED = [
  "**The memory layer caught its own blind spot.** 🧠",
  "",
  "A smol move: read [the receipt](https://example.com/a-(b)) - then decide!",
  "",
  "• keep the paragraphs",
  "• render the bullets",
  "• escape nasty punctuation: . ! - ( )",
].join("\n");

const CURATOR_MARKDOWN_V2 = [
  "*The memory layer caught its own blind spot\\.* 🧠",
  "",
  "A smol move: read [the receipt](https://example.com/a-(b\\)) \\- then decide\\!",
  "",
  "• keep the paragraphs",
  "• render the bullets",
  "• escape nasty punctuation: \\. \\! \\- \\( \\)",
].join("\n");

const CURATOR_PLAIN = [
  "The memory layer caught its own blind spot. 🧠",
  "",
  "A smol move: read the receipt - then decide!",
  "",
  "• keep the paragraphs",
  "• render the bullets",
  "• escape nasty punctuation: . ! - ( )",
].join("\n");

describe("Telegram markdown preflight", () => {
  test("renders a curator-shaped DM as safe MarkdownV2", () => {
    const prepared = prepareTelegramMarkdown(CURATOR_DM);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.markdownV2).toBe(CURATOR_MARKDOWN_V2);
    expect(prepared.markdownV2).toContain("\n\nA smol move");
    expect(prepared.markdownV2).toContain("\n\n• keep the paragraphs");
    expect(prepared.plainText).toBe(CURATOR_PLAIN);
    expect(prepared.postable).toEqual({ markdown: CURATOR_NORMALIZED });
  });

  test("the SDK adapter retries a MarkdownV2 400 as plain text", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let sendAttempts = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as Record<string, unknown>;
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        calls.push({ method, body });
        if (method === "sendRichMessage") {
          return Response.json(
            { ok: false, error_code: 404, description: "method not found" },
            { status: 404 },
          );
        }
        if (method === "sendMessage" && sendAttempts++ === 0) {
          return Response.json(
            { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
            { status: 400 },
          );
        }
        return Response.json({
          ok: true,
          result: {
            message_id: 42,
            date: 1,
            chat: { id: 7, type: "private" },
            text: body.text,
          },
        });
      },
    });

    try {
      const adapter = new TelegramAdapter({
        botToken: "fixture-token",
        apiUrl: `http://127.0.0.1:${server.port}`,
      });
      const sent = await adapter.postMessage(
        "telegram:7",
        prepareTelegramMarkdown(CURATOR_DM).postable,
      );

      expect(sent.id).toBe("7:42");
      expect(calls.map((call) => call.method)).toEqual([
        "sendRichMessage",
        "sendMessage",
        "sendMessage",
      ]);
      expect(calls[1]?.body).toMatchObject({
        parse_mode: "MarkdownV2",
        text: CURATOR_MARKDOWN_V2,
      });
      expect(calls[2]?.body).toEqual({
        chat_id: "7",
        text: CURATOR_PLAIN,
      });
    } finally {
      server.stop(true);
    }
  });

  test("the SDK adapter bounds both MarkdownV2 and plain fallback payloads", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    let sendAttempts = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as Record<string, unknown>;
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        if (method === "sendRichMessage") {
          return Response.json(
            { ok: false, error_code: 404, description: "method not found" },
            { status: 404 },
          );
        }
        payloads.push(body);
        if (sendAttempts++ === 0) {
          return Response.json(
            { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
            { status: 400 },
          );
        }
        return Response.json({
          ok: true,
          result: {
            message_id: 43,
            date: 1,
            chat: { id: 7, type: "private" },
            text: body.text,
          },
        });
      },
    });

    try {
      const adapter = new TelegramAdapter({
        botToken: "fixture-token",
        apiUrl: `http://127.0.0.1:${server.port}`,
      });
      await adapter.postMessage("telegram:7", {
        markdown: `${CURATOR_NORMALIZED}\n\n${"Long line . ! - ( ) ".repeat(400)}`,
      });

      expect(payloads).toHaveLength(2);
      for (const payload of payloads) {
        expect(String(payload.text).length).toBeLessThanOrEqual(4096);
      }
      expect(payloads[0]?.parse_mode).toBe("MarkdownV2");
      expect(payloads[1]?.parse_mode).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("the SDK adapter does not plain-retry an ambiguous 5xx", async () => {
    const calls: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        calls.push(method);
        if (method === "sendRichMessage") {
          return Response.json(
            { ok: false, error_code: 404, description: "method not found" },
            { status: 404 },
          );
        }
        return Response.json(
          { ok: false, error_code: 500, description: "temporary upstream failure" },
          { status: 500 },
        );
      },
    });

    try {
      const adapter = new TelegramAdapter({
        botToken: "fixture-token",
        apiUrl: `http://127.0.0.1:${server.port}`,
      });
      await expect(
        adapter.postMessage("telegram:7", prepareTelegramMarkdown(CURATOR_DM).postable),
      ).rejects.toThrow("temporary upstream failure");
      expect(calls).toEqual(["sendRichMessage", "sendMessage"]);
    } finally {
      server.stop(true);
    }
  });

  test("fails soft to raw plain text when conversion throws", () => {
    const prepared = prepareTelegramMarkdown(CURATOR_DM, {
      fromMarkdown() {
        throw new Error("fixture conversion failure");
      },
    });

    expect(prepared).toMatchObject({
      ok: false,
      markdownV2: null,
      postable: { raw: CURATOR_PLAIN },
    });
  });
});
