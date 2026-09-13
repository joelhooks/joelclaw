import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vitest";
import { createImsgExec } from "./imsg-cli.ts";
import { createImsgMcpHttpApp } from "./http-server.ts";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-imsg.sh", import.meta.url));
const token = "0123456789abcdef0123456789abcdef0123456789abcdef";

describe("imsg MCP HTTP transport", () => {
  test("bearer-protected streamable HTTP surface", async () => {
    const app = createImsgMcpHttpApp({ token, exec: createImsgExec({ bin: FAKE }), version: "0.15.4" });
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", imsg: "0.15.4" });

      // undici fetch refuses to override Host, so use a raw request for the 421 check.
      const badHostStatus = await new Promise<number | undefined>((r, j) => {
        const req = httpRequest(`${base}/healthz`, { headers: { host: "evil.example" } }, (res) => {
          res.resume();
          r(res.statusCode);
        });
        req.on("error", j);
        req.end();
      });
      expect(badHostStatus).toBe(421);

      const unauthorized = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
      expect(unauthorized.status).toBe(401);

      const wrong = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.slice(0, -1)}x`, "content-type": "application/json" },
        body: "{}",
      });
      expect(wrong.status).toBe(401);

      const malformed = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{",
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ jsonrpc: "2.0", error: { code: -32_700, message: "Parse error" }, id: null });

      expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);

      const client = new Client({ name: "test", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      try {
        const listed = await client.listTools();
        expect(listed.tools.map((t) => t.name)).toEqual([
          "imsg_status", "imsg_chats", "imsg_group", "imsg_history", "imsg_send",
        ]);
        const chats = await client.callTool({ name: "imsg_chats", arguments: { limit: 2 } });
        const payload = JSON.parse((chats.content as Array<{ text: string }>)[0]?.text ?? "{}");
        expect(payload.chats).toHaveLength(2);
      } finally {
        await client.close();
      }
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });

  test("rejects short tokens at startup", () => {
    expect(() => createImsgMcpHttpApp({ token: "short" })).toThrow(/at least 32 bytes/u);
  });
});
