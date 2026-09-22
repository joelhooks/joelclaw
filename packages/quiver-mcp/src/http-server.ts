// Loopback HTTP MCP for QuiverAI, registered in Executor as a remote server.
// Same shape as packages/imsg-mcp: bearer-guarded /mcp, open /healthz, Host check,
// secrets leased from agent-secrets at startup, nothing secret in the plist.
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { createQuiverMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp-server.ts";
import { createQuiverClient, type QuiverClient } from "./quiver-client.ts";

const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4794;
const MIN_TOKEN_BYTES = 32;
const DEFAULT_SECRETS_BIN = "/Users/joel/.local/bin/secrets";
export const BEARER_SECRET = "quiver_mcp_bearer_token";
export const API_KEY_SECRET = "quiver_api_key";

export interface QuiverHttpOptions {
  readonly token: string;
  readonly client: QuiverClient;
  readonly outDir?: string;
}

export interface QuiverHttpRuntimeOptions extends QuiverHttpOptions {
  readonly host?: string;
  readonly port?: number;
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function assertToken(token: string): void {
  if (Buffer.byteLength(token, "utf8") < MIN_TOKEN_BYTES) {
    throw new Error(`QUIVER_MCP_TOKEN must contain at least ${MIN_TOKEN_BYTES} bytes`);
  }
}

function localHost(header: string | undefined): boolean {
  if (header === undefined) return false;
  const hostname = header.replace(/:\d+$/u, "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost";
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

export function createQuiverMcpHttpApp(options: QuiverHttpOptions) {
  assertToken(options.token);
  const app = express();
  app.disable("x-powered-by");

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!localHost(request.header("host"))) {
      response.status(421).json({ status: "invalid-host" });
      return;
    }
    next();
  });

  app.get("/healthz", (_request: Request, response: Response) => {
    response.status(200).json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.use("/mcp", (request: Request, response: Response, next: NextFunction) => {
    if (!authorized(request.header("authorization"), options.token)) {
      response.status(401).json(rpcError(-32_000, "Unauthorized"));
      return;
    }
    next();
  });

  app.use(express.json({ limit: "20mb" }));
  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof SyntaxError) {
      response.status(400).json(rpcError(-32_700, "Parse error"));
      return;
    }
    next(error);
  });

  app.post("/mcp", async (request: Request, response: Response) => {
    const server = createQuiverMcpServer({
      client: options.client,
      ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) response.status(500).json(rpcError(-32_603, "Internal server error"));
    }
  });

  const notAllowed = (_request: Request, response: Response) => {
    response.status(405).json(rpcError(-32_000, "Method not allowed"));
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return app;
}

export async function startQuiverMcpHttpServer(options: QuiverHttpRuntimeOptions): Promise<HttpServer> {
  const host = options.host ?? DEFAULT_HOST;
  if (host !== DEFAULT_HOST) throw new Error("quiver MCP must bind to 127.0.0.1");
  const port = options.port ?? DEFAULT_PORT;
  const app = createQuiverMcpHttpApp(options);
  const server = createServer(app);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  return server;
}

function leaseSecret(secretsBin: string, name: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      secretsBin,
      ["lease", name, "--ttl", "24h"],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error(`lease of ${name} failed (${secretsBin} exit ${String(error.code ?? "?")})`));
          return;
        }
        const value = stdout.trim();
        if (value === "") {
          rejectPromise(new Error(`lease of ${name} returned nothing`));
          return;
        }
        resolvePromise(value);
      },
    );
  });
}

const LEASE_BACKOFF_MS = [2_000, 4_000, 8_000] as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function leaseWithRetry(secretsBin: string, name: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= LEASE_BACKOFF_MS.length; attempt += 1) {
    try {
      return await leaseSecret(secretsBin, name);
    } catch (error) {
      lastError = error;
      const delay = LEASE_BACKOFF_MS[attempt];
      if (delay === undefined) break;
      process.stderr.write(
        `${SERVER_NAME}: lease of ${name} attempt ${attempt + 1} failed; retrying in ${delay / 1000}s\n`,
      );
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`lease of ${name} failed`);
}

async function resolveSecret(env: NodeJS.ProcessEnv, envName: string, secretName: string): Promise<string> {
  const fromEnv = env[envName]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const secretsBin = env.QUIVER_MCP_SECRETS_BIN?.trim() || DEFAULT_SECRETS_BIN;
  return leaseWithRetry(secretsBin, secretName);
}

async function main(): Promise<void> {
  const env = process.env;
  const portValue = env.QUIVER_MCP_PORT;
  const port = portValue === undefined || portValue === "" ? DEFAULT_PORT : Number.parseInt(portValue, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("QUIVER_MCP_PORT must be a valid TCP port");
  }
  const token = await resolveSecret(env, "QUIVER_MCP_TOKEN", BEARER_SECRET);
  const apiKey = await resolveSecret(env, "QUIVER_API_KEY", API_KEY_SECRET);
  const baseUrl = env.QUIVER_API_BASE_URL?.trim();
  const client = createQuiverClient({
    apiKey,
    ...(baseUrl === undefined || baseUrl === "" ? {} : { baseUrl }),
  });
  const outDir = env.QUIVER_MCP_OUT_DIR?.trim();
  const server = await startQuiverMcpHttpServer({
    token,
    client,
    port,
    ...(outDir === undefined || outDir === "" ? {} : { outDir }),
  });
  process.stderr.write(`${SERVER_NAME}: listening on ${DEFAULT_HOST}:${port}\n`);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`${SERVER_NAME}: HTTP startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
