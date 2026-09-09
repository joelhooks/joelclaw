import { describe, expect, it } from "vitest";

import {
  __executorClientTestUtils,
  ExecutorSupermemoryAdapter,
  type ExecutorTransport,
} from "../src/executor-client.js";

class StaticTransport implements ExecutorTransport {
  constructor(private readonly value: unknown) {}
  async execute(): Promise<unknown> {
    return this.value;
  }
}

const connection = "supermemory_mcp.org.privateConnection";
const nested = (structuredContent: unknown) => ({
  ok: true,
  result: { ok: true, data: { structuredContent } },
});

describe("Executor Supermemory adapter", () => {
  it("returns remote memory IDs only after exact source-reference reconciliation", async () => {
    const adapter = new ExecutorSupermemoryAdapter(
      new StaticTransport(
        nested({
          containerTag: "private_space_key",
          results: [
            { id: "correction-1", text: "Corrects: flowing-record:abc" },
            { id: "memory-1", text: "Fact\nSource reference: flowing-record:abc" },
          ],
        }),
      ),
      "private_space_key",
      connection,
    );
    expect(await adapter.find("flowing-record:abc")).toEqual({ memoryId: "memory-1" });
  });

  it("JSON-encodes payloads and pins one discovered connection identity", () => {
    const dangerous = 'hello"; throw new Error("owned") //';
    const code = __executorClientTestUtils.executorCode({
      connection,
      intent: "add_memory",
      arguments: { content: dangerous, action: "save" },
    });
    expect(code).toContain(JSON.stringify(dangerous));
    expect(code).toContain("connection_identity_ambiguous");
    expect(code).toContain("matches.length !== 1");
    expect(code).not.toContain(`content: ${dangerous}`);
  });

  it("rejects nested MCP failures even when Executor itself succeeded", async () => {
    const transport = new StaticTransport({
      ok: true,
      result: { ok: false, error: { message: "denied" } },
    });
    const adapter = new ExecutorSupermemoryAdapter(transport, "private_space_key", connection);
    await expect(adapter.verifySpace()).rejects.toThrow("nested Supermemory call failed");
  });

  it("blocks a configured destination that is not private", async () => {
    const adapter = new ExecutorSupermemoryAdapter(
      new StaticTransport(
        nested({
          spaces: [{ containerTag: "private_space_key", visibility: "public" }],
        }),
      ),
      "private_space_key",
      connection,
    );
    await expect(adapter.verifySpace()).rejects.toThrow("destination is not private");
  });

  it("keeps save document IDs distinct from searchable memory IDs", async () => {
    const adapter = new ExecutorSupermemoryAdapter(
      new StaticTransport(
        nested({
          success: true,
          action: "save",
          containerTag: "private_space_key",
          id: "document-1",
          status: "queued",
        }),
      ),
      "private_space_key",
      connection,
    );
    expect(await adapter.save("safe")).toEqual({ documentId: "document-1", status: "queued" });
  });
});
