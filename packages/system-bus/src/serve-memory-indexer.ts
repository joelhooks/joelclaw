import { Hono } from "hono";
import { serve as inngestServe } from "inngest/hono";
import { getInngestAppId, inngest } from "./inngest/client";
import { memoryIndexerFunctionDefinitions, memoryIndexerFunctionIds } from "./inngest/functions/index.memory-indexer";
import { emitOtelEvent } from "./observability/emit";

const WORKER_ROLE = "memory-indexer" as const;
const WORKER_STARTED_AT = new Date().toISOString();
const INNGEST_ALLOWED_METHODS = "GET, POST, PUT";

type InngestServeOptions = {
  client: typeof inngest;
  functions: any[];
  serveHost?: string;
  skipSignatureValidation?: boolean;
};

function shouldSkipInngestSignatureValidation(): boolean {
  const explicit = process.env.INNGEST_DEV?.trim().toLowerCase();
  if (explicit === "1" || explicit === "true") return true;

  const endpoint = process.env.INNGEST_URL ?? process.env.INNGEST_BASE_URL ?? "http://localhost:8288";
  const isLocalEndpoint = /(^|\/\/)(localhost|127\.0\.0\.1|host\.docker\.internal)(:|\/|$)/.test(
    endpoint,
  );
  if (isLocalEndpoint) return true;
  if (explicit === "0" || explicit === "false") return false;
  return false;
}

function getPort(): number {
  const port = Number.parseInt(process.env.MEMORY_INDEXER_PORT ?? "3112", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid MEMORY_INDEXER_PORT: ${process.env.MEMORY_INDEXER_PORT}`);
  }
  return port;
}

export function createMemoryIndexerApp() {
  const app = new Hono();
  const serveHost = process.env.INNGEST_SERVE_HOST?.trim() || "http://127.0.0.1:3112";
  const options: InngestServeOptions = {
    client: inngest,
    functions: memoryIndexerFunctionDefinitions,
    serveHost,
    skipSignatureValidation: shouldSkipInngestSignatureValidation(),
  };
  const handler = inngestServe(options);
  const health = () => ({
    service: "system-bus",
    status: "running",
    role: WORKER_ROLE,
    appId: getInngestAppId(),
    startedAt: WORKER_STARTED_AT,
    count: memoryIndexerFunctionIds.length,
    functions: memoryIndexerFunctionIds,
  });

  app.get("/", (c) => c.json(health()));
  app.get("/health", (c) => c.json(health()));
  app.on(["PATCH", "OPTIONS", "DELETE"], "/api/inngest", (c) => {
    c.header("Allow", INNGEST_ALLOWED_METHODS);
    return c.json({ ok: false, error: "Method not allowed" }, 405);
  });
  app.on(["GET", "POST", "PUT"], "/api/inngest", (c) => handler(c));
  return app;
}

export function startMemoryIndexer() {
  const port = getPort();
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    idleTimeout: 255,
    fetch: createMemoryIndexerApp().fetch,
  });

  console.log(`[memory-indexer] running on http://localhost:${port}`);
  console.log(`[memory-indexer] Inngest app: ${getInngestAppId()}`);
  console.log(`[memory-indexer] ${memoryIndexerFunctionIds.length} functions registered`);

  setTimeout(() => {
    void fetch(`http://127.0.0.1:${port}/api/inngest`, { method: "PUT" }).catch((error) => {
      console.error(`[memory-indexer] function registry sync failed: ${String(error)}`);
    });
  }, 5_000);

  void emitOtelEvent({
    level: "info",
    source: "worker",
    component: "memory-indexer",
    action: "worker.started",
    success: true,
    metadata: {
      port,
      workerRole: WORKER_ROLE,
      appId: getInngestAppId(),
      registeredFunctions: memoryIndexerFunctionIds.length,
      functionIds: memoryIndexerFunctionIds,
      startedAt: WORKER_STARTED_AT,
    },
  }).catch((error) => {
    console.warn(`[memory-indexer] startup telemetry failed: ${String(error)}`);
  });

  return server;
}

if (import.meta.main) startMemoryIndexer();
