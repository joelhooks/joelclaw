import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vitest";
import { createQuiverMcpHttpApp } from "./http-server.ts";
import type { QuiverClient } from "./quiver-client.ts";

const token = "0123456789abcdef0123456789abcdef0123456789abcdef";
const client: QuiverClient = {
  async listModels() {
    return [{ id: "arrow-1.1", name: "Arrow 1.1", description: undefined, supportedOperations: [], pricingCredits: {} }];
  },
  async generate() {
    throw new Error("not used");
  },
  async vectorize() {
    throw new Error("not used");
  },
};

describe("quiver MCP HTTP transport", () => {
  test("bearer-protected streamable HTTP surface", async () => {
    const server = createServer(createQuiverMcpHttpApp({ token, client }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", server: "quiver-mcp", version: "0.1.0" });

      const unauthorized = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);
      expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);

      const mcp = new Client({ name: "test", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await mcp.connect(transport);
      try {
        const tools = await mcp.listTools();
        expect(tools.tools).toHaveLength(3);
        const models = await mcp.callTool({ name: "quiver_models", arguments: {} });
        const text = (models.content as { text: string }[])[0]?.text ?? "";
        expect(JSON.parse(text)).toEqual({
          ok: true,
          models: [{ id: "arrow-1.1", name: "Arrow 1.1", supportedOperations: [], pricingCredits: {} }],
        });
      } finally {
        await mcp.close();
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("rejects short tokens", () => {
    expect(() => createQuiverMcpHttpApp({ token: "short", client })).toThrow(/at least 32 bytes/u);
  });
});
