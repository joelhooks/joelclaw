import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
export const PARALLEL_USER_AGENT =
  "joelclaw-research/0.2.0 (+https://github.com/joelhooks/joelclaw)";
const MAX_OUTPUT_CHARS = 16_000;

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`parallel handler requires config.${field}`);
  }
  return value.trim();
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error(`parallel handler requires 1–20 config.${field} values`);
  }
  return value.map((item) => nonEmptyString(item, field));
}

/** Anonymous, read-only MCP search/fetch. Explicit failures never select another provider. */
export async function executeParallel(
  config: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<string> {
  const operation = config.operation ?? "search";
  let tool: "web_search" | "web_fetch";
  let args: Record<string, unknown>;
  if (operation === "search") {
    tool = "web_search";
    args = {
      objective: nonEmptyString(config.objective, "objective"),
      search_queries: stringList(config.search_queries, "search_queries"),
    };
  } else if (operation === "fetch") {
    tool = "web_fetch";
    const urls = stringList(config.urls, "urls");
    for (const value of urls) {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("parallel fetch requires HTTP(S) URLs without credentials");
      }
    }
    args = { urls };
    if (config.objective !== undefined) {
      const objective = nonEmptyString(config.objective, "objective");
      if (objective.length > 200)
        throw new Error("parallel fetch objective exceeds 200 characters");
      args.objective = objective;
    }
  } else {
    throw new Error("parallel handler operation must be search or fetch");
  }

  if (sessionId) args.session_id = sessionId;

  const deadline = AbortSignal.timeout(Math.floor(timeoutMs));
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  abort.throwIfAborted();
  const client = new Client({ name: "joelclaw-research", version: "0.2.0" });
  const transport = new StreamableHTTPClientTransport(new URL(PARALLEL_MCP_URL), {
    // The transport owns all discovery, search and fetch requests. No ambient
    // API key, saved credential, cookie or OAuth provider is consulted.
    fetch: async (input, init) => {
      const destination = input instanceof Request ? input.url : String(input);
      if (destination !== PARALLEL_MCP_URL) throw new Error("Unexpected Parallel MCP destination");
      const headers = new Headers(init?.headers);
      headers.set("User-Agent", PARALLEL_USER_AGENT);
      const requestSignal = init?.signal ? AbortSignal.any([abort, init.signal]) : abort;
      return fetch(input, { ...init, headers, signal: requestSignal, redirect: "error" });
    },
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((candidate) => candidate.name === tool)) {
      throw new Error(`Parallel MCP does not expose ${tool}`);
    }
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      signal: abort,
      timeout: timeoutMs,
    });
    if (result.isError) throw new Error(`Parallel ${tool} failed`);
    const content = result.content;
    if (!Array.isArray(content)) throw new Error("Parallel MCP returned invalid content");
    const text = content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n\n");
    if (!text.trim()) throw new Error("Parallel MCP returned no text content");
    return text.length > MAX_OUTPUT_CHARS
      ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`
      : text;
  } finally {
    await client.close().catch(() => {});
  }
}
