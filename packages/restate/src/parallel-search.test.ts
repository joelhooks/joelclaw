import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@restatedev/restate-sdk";
import { PARALLEL_MCP_URL, PARALLEL_USER_AGENT } from "./parallel-search";
import { buildResearchPipeline, parseResearchSearchProvider } from "./research-pipeline";
import {
  dagWorker,
  type DagNodeInput,
  type DagWorkerRequest,
  type DagWorkerResult,
  validateAndNormalize,
} from "./workflows/dag-orchestrator";

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
const originalParallelKey = process.env.PARALLEL_API_KEY;
const originalBraveKey = process.env.BRAVE_API_KEY;
const scratch: string[] = [];
// SDK 1.10.4 exposes service handlers at runtime but erases them from the public
// ServiceDefinition type. Keep this test-only access at the SDK boundary.
const executeWorker = (
  dagWorker as unknown as {
    service: { execute: (ctx: Context, input: DagWorkerRequest) => Promise<DagWorkerResult> };
  }
).service.execute;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  for (const [key, value] of [
    ["PARALLEL_API_KEY", originalParallelKey],
    ["BRAVE_API_KEY", originalBraveKey],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type ObservedRequest = { url: string; headers: Headers; body: Record<string, any> };
type FixtureOptions = {
  error?: boolean;
  malformed?: boolean;
  missingTool?: boolean;
  httpStatus?: number;
  hang?: string;
  text?: string;
};

function mcpFixture(options: FixtureOptions = {}) {
  const requests: ObservedRequest[] = [];
  let aborted = false;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    // The actual worker emits OTEL before and after dispatch.
    if (url !== PARALLEL_MCP_URL) {
      expect(url).toContain("/observability/emit");
      return Response.json({ ok: true });
    }
    if (init?.method === "GET") {
      requests.push({ url, headers: new Headers(init.headers), body: { method: "GET" } });
      return new Response(null, { status: 405 });
    }
    const body = JSON.parse(String(init?.body));
    requests.push({ url, headers: new Headers(init?.headers), body });
    if (options.hang === body.method) {
      return new Promise<Response>((_resolve, reject) => {
        const cancel = () => {
          aborted = true;
          reject(init?.signal?.reason ?? new Error("aborted"));
        };
        if (init?.signal?.aborted) cancel();
        else init?.signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    if (options.httpStatus)
      return new Response("provider unavailable", { status: options.httpStatus });
    if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") {
      return new Response(null, { status: 202 });
    }
    let result: unknown;
    if (body.method === "initialize") {
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "research-fixture", version: "1" },
      };
    } else if (body.method === "tools/list") {
      result = {
        tools: options.missingTool
          ? []
          : ["web_search", "web_fetch"].map((name) => ({
              name,
              inputSchema: { type: "object", properties: {} },
            })),
      };
    } else {
      expect(body.method).toBe("tools/call");
      result = options.malformed
        ? { content: "broken" }
        : {
            content: [
              {
                type: "text",
                text:
                  options.text ??
                  "# Restate\nhttps://restate.dev/docs\nDurable execution preserves workflow progress.",
              },
            ],
            isError: options.error ?? false,
          };
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  }) as typeof fetch;
  return { requests, wasAborted: () => aborted };
}

async function runNode(
  node: DagNodeInput,
  outputs: Record<string, string> = {},
  signal = new AbortController().signal,
) {
  const normalized = validateAndNormalize([
    node.dependsOn?.length ? { ...node, dependsOn: [] } : node,
  ])[0]!;
  const input: DagWorkerRequest = {
    nodeId: node.id,
    task: node.task,
    wave: 0,
    dependsOn: node.dependsOn ?? [],
    handler: normalized.handler,
    config: normalized.config,
    dependencyOutputs: outputs,
    workflowId: "research-fixture-workflow",
    pipeline: "research",
  };
  const ctx = {
    run: async (_name: string, action: () => unknown) => action(),
    request: () => ({ attemptCompletedSignal: signal }),
  } as unknown as Context;
  return executeWorker(ctx, input);
}

test("research resolver preserves the keyless default, explicit choices and disabled web search", async () => {
  const fixture = mcpFixture();
  const defaultNodes = buildResearchPipeline("Restate durable execution");
  expect(defaultNodes).toEqual(buildResearchPipeline("Restate durable execution", "duckduckgo"));
  expect(defaultNodes[0]?.handler).toBe("shell");
  expect(defaultNodes[0]?.config?.command).toContain("https://api.duckduckgo.com/");
  expect(parseResearchSearchProvider([])).toBe("duckduckgo");
  expect(parseResearchSearchProvider(["--search-provider", "parallel"])).toBe("parallel");
  expect(() =>
    parseResearchSearchProvider(["--search-provider", "parallel", "--search-provider", "none"]),
  ).toThrow("only once");
  for (const args of [
    ["--search-provider"],
    ["--search-provider", "unknown"],
    ["--search-provider", "--topic"],
  ]) {
    expect(() => parseResearchSearchProvider(args)).toThrow(
      "requires duckduckgo, parallel, or none",
    );
  }
  const none = buildResearchPipeline("private topic", "none")[0]!;
  expect((await runNode(none)).output).toContain("Web search disabled");
  expect(fixture.requests).toHaveLength(0);
  // Explicit custom DAG handlers remain available through the same worker.
  expect(
    (
      await runNode({
        id: "custom",
        task: "custom command",
        handler: "shell",
        config: { command: "printf configured-choice" },
      })
    ).output,
  ).toContain("configured-choice");
});

test("actual worker dispatch sends anonymous MCP requests and scripted Pi synthesis consumes source URLs", async () => {
  process.env.PARALLEL_API_KEY = "unused-test-key";
  process.env.BRAVE_API_KEY = "unused-brave-test-key";
  const fixture = mcpFixture();
  const nodes = buildResearchPipeline("Restate durable execution", "parallel");
  const result = await runNode(nodes[0]!);
  expect(result.output).toContain("Durable execution preserves workflow progress");
  const calls = fixture.requests.filter((r) => r.body.method === "tools/call");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body.params.name).toBe("web_search");
  expect(calls[0]?.body.params.arguments).toMatchObject({
    objective: "Restate durable execution",
    search_queries: ["Restate durable execution"],
  });
  expect(calls[0]?.body.params.arguments.session_id).toMatch(/^[a-f0-9]{64}$/);
  for (const request of fixture.requests) {
    expect(request.url).toBe(PARALLEL_MCP_URL);
    expect(request.headers.get("User-Agent")).toBe(PARALLEL_USER_AGENT);
    expect(request.headers.has("Authorization")).toBe(false);
    expect(request.headers.has("Cookie")).toBe(false);
  }
  expect(fixture.requests.map((r) => r.body.method)).toContain("initialize");
  expect(fixture.requests.map((r) => r.body.method)).toContain("tools/list");

  // A scripted stdin consumer exercises the real infer subprocess path. This
  // verifies prompt/result plumbing; it is not a live model or agent-loop test.
  const directory = await mkdtemp(join(tmpdir(), "joelclaw-scripted-pi-"));
  scratch.push(directory);
  const executable = join(directory, "pi");
  await writeFile(
    executable,
    '#!/usr/bin/env node\nconst fs = require("node:fs"); console.log(JSON.stringify({text: "Scripted synthesis received:\\n" + fs.readFileSync(0, "utf8")}));\n',
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${directory}:${originalPath}`;
  const synthesis = await runNode(nodes.find((n) => n.id === "synthesize")!, {
    "web-search": result.output,
    "vault-search": "Vault fixture",
    "memory-recall": "Memory fixture",
  });
  expect(synthesis.output).toContain("Scripted synthesis received:");
  expect(synthesis.output).toContain("https://restate.dev/docs");
  expect(synthesis.output).toContain("Durable execution preserves workflow progress");
  expect(synthesis.output).not.toContain("{{web-search}}");
});

test("fetch dispatch preserves URLs, uses the same session, and rejects unsupported inputs before network access", async () => {
  const fixture = mcpFixture();
  await runNode(buildResearchPipeline("Restate durable execution", "parallel")[0]!);
  await runNode({
    id: "fetch",
    task: "read sources",
    handler: "parallel",
    config: { operation: "fetch", urls: ["https://restate.dev/docs?topic=durable#intro"] },
  });
  const calls = fixture.requests.filter((r) => r.body.method === "tools/call");
  const call = calls[1]!;
  expect(call.body.params.arguments.session_id).toBe(calls[0]!.body.params.arguments.session_id);
  expect(call.body.params.name).toBe("web_fetch");
  expect(call.body.params.arguments.urls).toEqual(["https://restate.dev/docs?topic=durable#intro"]);
  expect(fixture.requests.every((r) => r.headers.get("User-Agent") === PARALLEL_USER_AGENT)).toBe(
    true,
  );
  const count = fixture.requests.length;
  for (const config of [
    { operation: "other" },
    { objective: "missing queries" },
    { operation: "fetch", urls: ["file:///etc/passwd"] },
    { operation: "fetch", urls: ["https://user:password@example.com/"] },
    { operation: "fetch", urls: [] },
    { operation: "fetch", urls: ["https://example.com"], objective: "x".repeat(201) },
  ]) {
    await expect(
      runNode({ id: "invalid", task: "invalid input", handler: "parallel", config }),
    ).rejects.toThrow();
  }
  expect(fixture.requests).toHaveLength(count);
});

test("provider, protocol, HTTP and discovery errors fail without another provider", async () => {
  for (const options of [
    { error: true },
    { malformed: true },
    { missingTool: true },
    { httpStatus: 401 },
    { httpStatus: 429 },
    { httpStatus: 503 },
    { text: "" },
  ]) {
    const fixture = mcpFixture(options);
    await expect(runNode(buildResearchPipeline("test", "parallel")[0]!)).rejects.toThrow();
    expect(fixture.requests.every((r) => r.url === PARALLEL_MCP_URL)).toBe(true);
    expect(
      fixture.requests.filter((r) => r.body.method === "tools/call").length,
    ).toBeLessThanOrEqual(1);
  }
});

test("worker timeout and Restate attempt completion abort in-flight MCP work", async () => {
  for (const method of ["initialize", "tools/list", "tools/call"]) {
    const fixture = mcpFixture({ hang: method });
    const node = buildResearchPipeline("test", "parallel")[0]!;
    node.config!.timeoutMs = 25;
    await expect(runNode(node)).rejects.toThrow();
    expect(fixture.wasAborted()).toBe(true);
  }
  const fixture = mcpFixture({ hang: "tools/call" });
  const controller = new AbortController();
  const pending = runNode(buildResearchPipeline("test", "parallel")[0]!, {}, controller.signal);
  const timer = setTimeout(() => controller.abort(new Error("attempt completed")), 25);
  try {
    await expect(pending).rejects.toThrow();
    expect(fixture.wasAborted()).toBe(true);
  } finally {
    clearTimeout(timer);
  }
  const before = fixture.requests.length;
  await expect(
    runNode(buildResearchPipeline("test", "parallel")[0]!, {}, controller.signal),
  ).rejects.toThrow();
  expect(fixture.requests).toHaveLength(before);
});

test("search output remains bounded for downstream prompts", async () => {
  mcpFixture({ text: "x".repeat(30_000) });
  const result = await runNode(buildResearchPipeline("test", "parallel")[0]!);
  expect(result.output.length).toBeLessThan(16_384);
  expect(result.output).toEndWith("[truncated]");
});

test("the advertised CLI submits the selected provider and preserves the synthesis dependency", async () => {
  const submitted: Array<{ nodes: DagNodeInput[] }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      submitted.push(await request.json());
      return Response.json({ nodeCount: 4, waveCount: 2, waves: [] });
    },
  });
  try {
    for (const provider of [undefined, "parallel", "none"]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "packages/restate/src/trigger-dag.ts",
          "--",
          "--pipeline",
          "research",
          "--topic",
          "Restate durable execution",
          ...(provider ? ["--search-provider", provider] : []),
        ],
        {
          cwd: join(import.meta.dir, "../../.."),
          env: { PATH: originalPath, HOME: tmpdir(), RESTATE_INGRESS_URL: server.url.origin },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    }
    expect(submitted.map((request) => request.nodes[0]?.handler)).toEqual([
      "shell",
      "parallel",
      "noop",
    ]);
    for (const request of submitted) {
      validateAndNormalize(request.nodes);
      expect(request.nodes.find((node) => node.id === "synthesize")?.dependsOn).toContain(
        "web-search",
      );
    }
  } finally {
    await server.stop(true);
  }
});
