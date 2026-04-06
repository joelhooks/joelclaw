import { afterEach, describe, expect, test } from "bun:test";

process.env.TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY ?? "test-typesense-key";

const {
  CHANNEL_MESSAGES_COLLECTION_SCHEMA,
  ensureChannelMessagesCollection,
} = await import("./typesense");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ensureChannelMessagesCollection", () => {
  test("skips patching when the only missing field is implicit immutable id", async () => {
    let patchCalls = 0;
    const existingFields = (CHANNEL_MESSAGES_COLLECTION_SCHEMA.fields as Array<Record<string, unknown>>)
      .filter((field) => field.name !== "id");

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/collections/channel_messages") && method === "GET") {
        return new Response(JSON.stringify({ fields: existingFields }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/collections/channel_messages") && method === "PATCH") {
        patchCalls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await ensureChannelMessagesCollection();

    expect(patchCalls).toBe(0);
  });

  test("never includes id in Typesense schema patch payloads", async () => {
    let patchBody: { fields?: Array<Record<string, unknown>> } | null = null;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/collections/channel_messages") && method === "GET") {
        return new Response(JSON.stringify({ fields: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/collections/channel_messages") && method === "PATCH") {
        patchBody = JSON.parse(String(init?.body ?? "{}")) as { fields?: Array<Record<string, unknown>> };
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await ensureChannelMessagesCollection();

    const fieldNames = (patchBody?.fields ?? []).map((field) => String(field.name ?? ""));
    expect(fieldNames).not.toContain("id");
    expect(fieldNames).toContain("channel_type");
    expect(fieldNames).toContain("concept_ids");
  });
});
