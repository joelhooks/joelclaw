import { describe, expect, mock, test } from "bun:test";
import { NotifyJoelError, notifyJoel, redactJoelMessage } from "./notify-joel";

const input = { kind: "needs_joel" as const, message: "Backup needs attention", source: "fixture" };
const leaseSecret = (name: string) =>
  name.endsWith("_url") ? "https://example.invalid/notify" : "fixture-key";

describe("notifyJoel", () => {
  test("leases at call time and sends the bearer header and webhook envelope", async () => {
    const lease = mock(leaseSecret);
    const fetch = mock(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }),
    );
    const dependencies = { leaseSecret: lease, fetch };
    expect(lease).not.toHaveBeenCalled();
    await notifyJoel(input, dependencies);
    await notifyJoel(input, dependencies);
    expect(lease.mock.calls.map(([name]) => name)).toEqual([
      "shitrat_grok_bot_webhook_url",
      "shitrat_grok_bot_webhook_sender_key",
      "shitrat_grok_bot_webhook_url",
      "shitrat_grok_bot_webhook_sender_key",
    ]);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://example.invalid/notify");
    expect(request).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" },
      redirect: "error",
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(request.body))).toEqual({
      source: "fixture",
      event: "needs_joel",
      message: input.message,
      links: [],
      agent: "system-bus",
      ts: expect.any(String),
    });
  });

  test.each(["_url", "_sender_key"])("missing %s secret throws before fetch", async (suffix) => {
    const fetch = mock(async () => new Response());
    await expect(
      notifyJoel(input, {
        leaseSecret: (name) => (name.endsWith(suffix) ? "" : leaseSecret(name)),
        fetch,
      }),
    ).rejects.toMatchObject({ name: "NotifyJoelError", code: "missing_secret" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("lease failures and error payloads never expose secret output", async () => {
    const fetch = mock(async () => new Response());
    for (const lease of [
      () => {
        throw new Error("private CLI output");
      },
      () => '{"error":"private"}',
    ]) {
      await expect(notifyJoel(input, { leaseSecret: lease, fetch })).rejects.toBeInstanceOf(
        NotifyJoelError,
      );
      try {
        await notifyJoel(input, { leaseSecret: lease, fetch });
      } catch (error) {
        expect(String(error)).not.toContain("private");
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("non-2xx and network errors throw typed errors without response or request secrets", async () => {
    await expect(
      notifyJoel(input, {
        leaseSecret,
        fetch: async () => new Response("private response", { status: 503 }),
      }),
    ).rejects.toMatchObject({ name: "NotifyJoelError", code: "http_error", status: 503 });
    await expect(
      notifyJoel(input, {
        leaseSecret,
        fetch: async () => {
          throw new Error("private URL and key");
        },
      }),
    ).rejects.toMatchObject({
      code: "request_failed",
      message: "Joel notification request failed or timed out",
    });
  });

  test("redacts paths in the actual request, keeps basenames, and caps plain text", async () => {
    const fetch = mock(async (_url: string, _init: RequestInit) => new Response());
    await notifyJoel(
      {
        ...input,
        message: "fix the storage `/volume/private/snapshots` and C:\\private\\dump.rdb",
      },
      { leaseSecret, fetch },
    );
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body)).message).toBe(
      "fix the storage snapshots and dump.rdb",
    );
    expect(redactJoelMessage("fix ~/private/storage and ../private/snapshots")).toBe(
      "fix storage and snapshots",
    );
    expect(
      redactJoelMessage("system/backup.typesense attempt: 1/10 storage/snapshot failure"),
    ).toBe("system/backup.typesense attempt: 1/10 storage/snapshot failure");
    expect(redactJoelMessage('fix "/volume/private directory/dump.rdb".')).toBe("fix dump.rdb.");
    expect(
      redactJoelMessage(
        "host=fixture-node ssh user@fixture-node on fixture-node failed fixture-node:/volume/private/dump.rdb",
      ),
    ).toBe("host=[host] ssh [host] on [host] failed [host]:dump.rdb");
    expect(redactJoelMessage("a".repeat(2_000))).toHaveLength(1_500);
    expect(
      redactJoelMessage(
        "https://example.invalid/private node.example.invalid 192.0.2.1 [2001:db8::1]",
      ),
    ).toBe("[address] [host] [address] [address]");
  });
});
