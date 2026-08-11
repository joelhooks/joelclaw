import { afterEach, describe, expect, test } from "bun:test";

process.env.TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY ?? "test-typesense-key";
process.env.TYPESENSE_WRITE_MAX_RETRIES = "1";
process.env.TYPESENSE_WRITE_BASE_BACKOFF_MS = "50";
process.env.TYPESENSE_WRITE_MAX_BACKOFF_MS = "50";

const {
  CHANNEL_MESSAGES_COLLECTION_SCHEMA,
  bulkImportAt,
  ensureChannelMessagesCollection,
  ensureCollectionAt,
  searchAt,
  typesenseRequestAt,
  upsertAt,
} = await import("./typesense");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ensureChannelMessagesCollection", () => {
  test("skips patching when the only missing field is implicit immutable id", async () => {
    let patchCalls = 0;
    const existingFields = (
      CHANNEL_MESSAGES_COLLECTION_SCHEMA.fields as Array<Record<string, unknown>>
    ).filter((field) => field.name !== "id");

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
    const patchRef: { body?: { fields?: Array<Record<string, unknown>> } } = {};

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
        patchRef.body = JSON.parse(String(init?.body ?? "{}")) as {
          fields?: Array<Record<string, unknown>>;
        };
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await ensureChannelMessagesCollection();

    const fieldNames = (patchRef.body?.fields ?? []).map((field) => String(field.name ?? ""));
    expect(fieldNames).not.toContain("id");
    expect(fieldNames).toContain("channel_type");
    expect(fieldNames).toContain("concept_ids");
  });
});

describe("explicit Typesense endpoint routing", () => {
  test("typesenseRequestAt uses the supplied node", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await typesenseRequestAt("http://books.test:8110/", "/health");

    expect(requestedUrl).toBe("http://books.test:8110/health");
  });

  test("searchAt keeps docs queries on the supplied node", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ found: 0, hits: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await searchAt("http://books.test:8110", {
      collection: "docs",
      q: "rat",
      query_by: "title",
    });

    expect(requestedUrl).toStartWith("http://books.test:8110/collections/docs/documents/search?");
  });

  test("upsertAt retries a transient response on the supplied node", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return requestedUrls.length === 1
        ? new Response("not ready", { status: 503 })
        : new Response("{}", { status: 200 });
    }) as typeof fetch;

    await upsertAt("http://books.test:8110/", "docs", { id: "doc-1" });

    expect(requestedUrls).toEqual([
      "http://books.test:8110/collections/docs/documents?action=upsert",
      "http://books.test:8110/collections/docs/documents?action=upsert",
    ]);
  });

  test("upsertAt retries a network error", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("connection reset");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await upsertAt("http://books.test:8110", "docs", { id: "doc-1" });

    expect(attempts).toBe(2);
  });

  test("upsertAt does not retry a permanent response", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response("bad document", { status: 400 });
    }) as unknown as typeof fetch;

    await expect(upsertAt("http://books.test:8110", "docs", { id: "bad" })).rejects.toThrow(
      "Typesense upsert failed (400)",
    );
    expect(attempts).toBe(1);
  });

  test("bulkImportAt reports JSONL record errors on the supplied node", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response('{"success":true}\n{"success":false,"error":"bad"}', {
        status: 200,
      });
    }) as typeof fetch;

    const result = await bulkImportAt(
      "http://books.test:8110/",
      "docs_chunks_v2",
      [{ id: "a" }, { id: "b" }],
      "upsert",
    );

    expect(requestedUrl).toBe(
      "http://books.test:8110/collections/docs_chunks_v2/documents/import?action=upsert",
    );
    expect(result).toEqual({ success: 1, errors: 1 });
  });

  test("bulkImportAt rejects short acknowledgement responses", async () => {
    globalThis.fetch = (async () =>
      new Response('{"success":true}\n', { status: 200 })) as unknown as typeof fetch;

    await expect(
      bulkImportAt("http://books.test:8110", "docs", [{ id: "doc-1" }, { id: "doc-2" }], "upsert"),
    ).rejects.toThrow("acknowledgement mismatch: sent 2, received 1");
  });

  test("bulkImportAt never retries ambiguous create failures", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      throw new TypeError("response lost");
    }) as unknown as typeof fetch;

    await expect(
      bulkImportAt("http://books.test:8110", "docs", [{ id: "doc-1" }], "create"),
    ).rejects.toThrow("response lost");
    expect(attempts).toBe(1);
  });

  test("ensureCollectionAt reads and creates on the supplied node", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url: String(input) });
      return method === "GET"
        ? new Response("missing", { status: 404 })
        : new Response("{}", { status: 201 });
    }) as typeof fetch;

    await ensureCollectionAt("http://books.test:8110/", "docs", {
      name: "docs",
      fields: [],
    });

    expect(requests).toEqual([
      { method: "GET", url: "http://books.test:8110/collections/docs" },
      { method: "POST", url: "http://books.test:8110/collections" },
    ]);
  });
});
