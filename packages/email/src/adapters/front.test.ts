import { afterEach, describe, expect, test } from "bun:test";
import { createFrontAdapter } from "./front";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function buildConversation() {
  return {
    id: "cnv_123",
    subject: "Need a reply",
    status: "unassigned",
    assignee: null,
    recipient: {
      handle: "alex@example.com",
      role: "from",
      name: "Alex",
    },
    tags: [],
    links: [],
    created_at: 1_775_513_385,
    is_private: false,
  };
}

function buildInbox() {
  return {
    id: "inb_123",
    name: "Primary",
    address: "joel@example.com",
  };
}

describe("createFrontAdapter.listConversations", () => {
  test("treats unread filters as unreplied and tolerates null pagination.next", async () => {
    const requests: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);

      if (url === "https://api2.frontapp.com/conversations/search/is%3Aunreplied?limit=10") {
        return new Response(
          JSON.stringify({
            _links: { self: url },
            _pagination: { next: null },
            _results: [buildConversation()],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const adapter = createFrontAdapter({ apiToken: "front-test-token" });
    const conversations = await adapter.listConversations("inb_123", {
      unread: true,
      limit: 10,
    });

    expect(requests).toEqual([
      "https://api2.frontapp.com/conversations/search/is%3Aunreplied?limit=10",
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      id: "cnv_123",
      subject: "Need a reply",
      from: {
        email: "alex@example.com",
        name: "Alex",
      },
      status: "open",
      isUnread: true,
    });
  });

  test("uses raw inbox listing for unfiltered conversation fetches", async () => {
    const requests: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);

      if (url === "https://api2.frontapp.com/inboxes/inb_123/conversations?limit=5") {
        return new Response(
          JSON.stringify({
            _links: { self: url },
            _results: [buildConversation()],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const adapter = createFrontAdapter({ apiToken: "front-test-token" });
    const conversations = await adapter.listConversations("inb_123", { limit: 5 });

    expect(requests).toEqual([
      "https://api2.frontapp.com/inboxes/inb_123/conversations?limit=5",
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe("cnv_123");
  });
});

describe("createFrontAdapter.listInboxes", () => {
  test("tolerates null pagination.next on inbox listing", async () => {
    const requests: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);

      if (url === "https://api2.frontapp.com/inboxes") {
        return new Response(
          JSON.stringify({
            _links: { self: url },
            _pagination: { next: null },
            _results: [buildInbox()],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const adapter = createFrontAdapter({ apiToken: "front-test-token" });
    const inboxes = await adapter.listInboxes();

    expect(requests).toEqual(["https://api2.frontapp.com/inboxes"]);
    expect(inboxes).toEqual([
      {
        id: "inb_123",
        name: "Primary",
        address: "joel@example.com",
      },
    ]);
  });
});
