import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createQuiverMcpServer, slugify, stamp } from "./mcp-server.ts";
import type { QuiverClient, SvgResponse } from "./quiver-client.ts";

const response = (svgs: string[]): SvgResponse => ({
  id: "gen_1",
  created: 1,
  credits: svgs.length * 3,
  usage: undefined,
  data: svgs.map((svg) => ({ mimeType: "image/svg+xml", svg })),
});

function fakeClient(log: unknown[]): QuiverClient {
  return {
    async listModels() {
      log.push(["listModels"]);
      return [{ id: "arrow-1.1", name: "Arrow 1.1", description: undefined, supportedOperations: [], pricingCredits: {} }];
    },
    async generate(request) {
      log.push(["generate", request]);
      return response(request.n === 2 ? ["<svg>1</svg>", "<svg>2</svg>"] : ["<svg>one</svg>"]);
    },
    async vectorize(request) {
      log.push(["vectorize", request]);
      return response(["<svg>traced</svg>"]);
    },
  };
}

async function connect(outDir: string, log: unknown[]) {
  const server = createQuiverMcpServer({ client: fakeClient(log), outDir, now: () => new Date(2026, 8, 22, 9, 30, 5) });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): unknown => {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? "null");
};

describe("quiver MCP server", () => {
  test("helpers", () => {
    expect(slugify("A Rat, Stacked!  ")).toBe("a-rat-stacked");
    expect(slugify("!!!")).toBe("svg");
    expect(stamp(new Date(2026, 8, 22, 9, 30, 5))).toBe("20260922-093005");
  });

  test("lists tools and generates files", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "quiver-mcp-"));
    const log: unknown[] = [];
    const { client, server } = await connect(outDir, log);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "quiver_generate_svg",
        "quiver_models",
        "quiver_vectorize_image",
      ]);

      const result = textOf(
        await client.callTool({ name: "quiver_generate_svg", arguments: { prompt: "A rat on a stack", n: 2 } }),
      ) as { ok: boolean; files: { path: string; bytes: number }[]; svg: string[]; credits: number; model: string };
      expect(result.ok).toBe(true);
      expect(result.model).toBe("arrow-1.1");
      expect(result.credits).toBe(6);
      expect(result.svg).toEqual(["<svg>1</svg>", "<svg>2</svg>"]);
      expect(result.files.map((file) => file.path)).toEqual([
        join(outDir, "20260922-093005-a-rat-on-a-stack-1.svg"),
        join(outDir, "20260922-093005-a-rat-on-a-stack-2.svg"),
      ]);
      expect(await readFile(result.files[1]!.path, "utf8")).toBe("<svg>2</svg>");
      expect(log[0]).toEqual(["generate", { prompt: "A rat on a stack", model: "arrow-1.1", n: 2 }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("vectorize needs exactly one source and reads local files", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "quiver-mcp-"));
    const image = join(outDir, "in.png");
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const log: unknown[] = [];
    const { client, server } = await connect(outDir, log);
    try {
      const both = await client.callTool({
        name: "quiver_vectorize_image",
        arguments: { url: "https://example.com/a.png", path: image },
      });
      expect(both.isError).toBe(true);

      const traced = textOf(
        await client.callTool({ name: "quiver_vectorize_image", arguments: { path: image, filename: "logo" } }),
      ) as { ok: boolean; files: { path: string }[]; model: string };
      expect(traced.ok).toBe(true);
      expect(traced.model).toBe("arrow-2");
      expect(traced.files[0]?.path).toBe(join(outDir, "20260922-093005-logo.svg"));
      const call = log.at(-1) as [string, { image: { base64: string }; autoCrop: boolean }];
      expect(call[0]).toBe("vectorize");
      expect(call[1].autoCrop).toBe(true);
      expect(call[1].image.base64.startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
