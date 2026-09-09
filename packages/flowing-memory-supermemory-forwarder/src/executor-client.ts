import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface SaveReceipt {
  readonly documentId: string | null;
  readonly status: string;
}

export interface FoundReceipt {
  readonly memoryId: string | null;
}

export interface SupermemoryPort {
  find(marker: string): Promise<FoundReceipt | null>;
  save(content: string): Promise<SaveReceipt>;
  verifySpace(): Promise<void>;
}

export interface ExecutorTransport {
  execute(code: string): Promise<unknown>;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const parseExecutorValue = (value: unknown): unknown => {
  const root = record(value);
  const content = root?.content;
  if (!Array.isArray(content)) return value;
  const textBlocks = content
    .map(record)
    .filter((item): item is Readonly<Record<string, unknown>> => item !== undefined)
    .filter((item) => item.type === "text")
    .map((item) => string(item.text))
    .filter((item): item is string => item !== undefined);
  const final = textBlocks.at(-1);
  if (final === undefined) return value;
  try {
    return JSON.parse(final) as unknown;
  } catch {
    return final;
  }
};

export class McpExecutorTransport implements ExecutorTransport {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async execute(code: string): Promise<unknown> {
    const client = new Client({ name: "flowing-memory-supermemory-forwarder", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.url));
    try {
      // SAFETY: both types come from the same SDK version. exactOptionalPropertyTypes
      // exposes the SDK transport class's optional sessionId declaration mismatch.
      await client.connect(transport as Transport, { timeout: this.timeoutMs });
      const result = await client.callTool(
        { name: "execute", arguments: { code } },
        undefined,
        { timeout: this.timeoutMs },
      );
      return parseExecutorValue(result);
    } finally {
      await transport.close().catch(() => undefined);
    }
  }
}

const nestedResult = (value: unknown): Readonly<Record<string, unknown>> => {
  const outer = record(value);
  if (outer?.ok !== true) throw new Error("executor execution failed");
  const result = record(outer.result);
  if (result?.ok !== true) throw new Error("nested Supermemory call failed");
  const data = record(result.data);
  if (data === undefined) throw new Error("nested Supermemory response has no data");
  if (data.isError === true) throw new Error("nested Supermemory response reported an error");
  const structured = record(data.structuredContent);
  if (structured === undefined) throw new Error("nested Supermemory response has no structured content");
  return structured;
};

const executorCode = (input: {
  readonly connection: string;
  readonly intent: "add_memory" | "listspaces" | "search_memory";
  readonly arguments: Readonly<Record<string, unknown>>;
}): string => {
  const serialized = JSON.stringify(input);
  return `const request = ${serialized};
const inventory = await tools.executor.coreTools.connections.list({});
const inventoryData = inventory?.data ?? inventory;
const connections = Array.isArray(inventoryData) ? inventoryData : (inventoryData.connections ?? inventoryData.items ?? []);
const expectedAddress = \`tools.\${request.connection}\`;
const connectionMatches = connections.filter((entry) => entry.address === expectedAddress);
if (connectionMatches.length !== 1) return { ok: false, error: "connection_identity_ambiguous" };
const found = await tools.search({ namespace: "supermemory_mcp", query: request.intent, limit: 20 });
const expectedPrefix = \`\${request.connection}.\`;
const matches = found.items.filter((entry) => entry.path?.startsWith(expectedPrefix) && entry.name === request.intent);
if (matches.length !== 1) return { ok: false, error: "tool_identity_ambiguous" };
const result = await tools[matches[0].path](request.arguments);
return { ok: true, result };`;
};

const hasOwnSourceMarker = (text: string, marker: string): boolean =>
  Array.from(text.matchAll(/(?:^|\s)Source\s+reference:\s+(\S+)/gu)).some(
    (match) => match[1] === marker,
  );

export class ExecutorSupermemoryAdapter implements SupermemoryPort {
  constructor(
    private readonly transport: ExecutorTransport,
    private readonly containerTag: string,
    private readonly connection: string,
  ) {}

  async find(marker: string): Promise<FoundReceipt | null> {
    const value = await this.transport.execute(
      executorCode({
        connection: this.connection,
        intent: "search_memory",
        arguments: { query: marker, containerTag: this.containerTag, includeProfile: false },
      }),
    );
    const structured = nestedResult(value);
    if (structured.containerTag !== this.containerTag) throw new Error("Supermemory searched the wrong space");
    const results = structured.results;
    if (!Array.isArray(results)) throw new Error("Supermemory search results are invalid");
    for (const candidate of results) {
      const item = record(candidate);
      const text = string(item?.text);
      if (text !== undefined && hasOwnSourceMarker(text, marker)) {
        return { memoryId: string(item?.id) ?? null };
      }
    }
    return null;
  }

  async save(content: string): Promise<SaveReceipt> {
    const value = await this.transport.execute(
      executorCode({
        connection: this.connection,
        intent: "add_memory",
        arguments: { content, action: "save", containerTag: this.containerTag },
      }),
    );
    const structured = nestedResult(value);
    if (
      structured.success !== true ||
      structured.action !== "save" ||
      structured.containerTag !== this.containerTag
    ) {
      throw new Error("Supermemory did not accept the save");
    }
    return {
      documentId: string(structured.id) ?? null,
      status: string(structured.status) ?? "accepted",
    };
  }

  async verifySpace(): Promise<void> {
    const value = await this.transport.execute(
      executorCode({ connection: this.connection, intent: "listspaces", arguments: {} }),
    );
    const structured = nestedResult(value);
    const spaces = structured.spaces;
    if (!Array.isArray(spaces)) throw new Error("Supermemory spaces response is invalid");
    const found = spaces
      .map(record)
      .find((candidate) => candidate?.containerTag === this.containerTag);
    if (found === undefined) throw new Error("configured Supermemory space is unavailable");
    if (found.visibility !== "private") {
      throw new Error("configured Supermemory destination is not private");
    }
  }
}

export const __executorClientTestUtils = {
  executorCode,
  hasOwnSourceMarker,
  nestedResult,
  parseExecutorValue,
};
