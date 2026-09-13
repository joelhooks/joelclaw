import { createServer, type Server as HttpServer } from "node:http";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { createImsgExec, imsgVersion, resolveImsgBin, type ImsgExec } from "./imsg-cli.ts";
import { createImsgMcpServer } from "./mcp-server.ts";

const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4793;
const MIN_TOKEN_BYTES = 32;
const DEFAULT_SECRETS_BIN = "/Users/joel/.local/bin/secrets";
const SECRET_NAME = "imsg_mcp_bearer_token";

export interface ImsgHttpOptions {
  readonly token: string;
  readonly exec?: ImsgExec;
  readonly version?: string | null;
}

export interface ImsgHttpRuntimeOptions extends ImsgHttpOptions {
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
    throw new Error(`IMSG_MCP_TOKEN must contain at least ${MIN_TOKEN_BYTES} bytes`);
  }
}

function localHost(header: string | undefined): boolean {
  if (header === undefined) return false;
  const hostname = header.replace(/:\d+$/u, "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost";
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

export function createImsgMcpHttpApp(options: ImsgHttpOptions) {
  assertToken(options.token);
  const exec = options.exec ?? createImsgExec();
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
    response.status(200).json({ status: "ok", imsg: options.version ?? null });
  });

  app.use("/mcp", (request: Request, response: Response, next: NextFunction) => {
    if (!authorized(request.header("authorization"), options.token)) {
      response.status(401).json(rpcError(-32_000, "Unauthorized"));
      return;
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));
  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof SyntaxError) {
      response.status(400).json(rpcError(-32_700, "Parse error"));
      return;
    }
    next(error);
  });

  app.post("/mcp", async (request: Request, response: Response) => {
    const server = createImsgMcpServer({ exec });
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

export async function startImsgMcpHttpServer(options: ImsgHttpRuntimeOptions): Promise<HttpServer> {
  const host = options.host ?? DEFAULT_HOST;
  if (host !== DEFAULT_HOST) throw new Error("imsg MCP must bind to 127.0.0.1");
  const port = options.port ?? DEFAULT_PORT;
  const app = createImsgMcpHttpApp(options);
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

function leaseToken(secretsBin: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      secretsBin,
      ["lease", SECRET_NAME, "--ttl", "24h"],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error(`token lease failed (${secretsBin} exit ${String(error.code ?? "?")})`));
          return;
        }
        resolvePromise(stdout.trim());
      },
    );
  });
}

const LEASE_BACKOFF_MS = [2_000, 4_000, 8_000] as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function leaseTokenWithRetry(secretsBin: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= LEASE_BACKOFF_MS.length; attempt += 1) {
    try {
      return await leaseToken(secretsBin);
    } catch (error) {
      lastError = error;
      const delay = LEASE_BACKOFF_MS[attempt];
      if (delay === undefined) break;
      process.stderr.write(`imsg-mcp: token lease attempt ${attempt + 1} failed; retrying in ${delay / 1000}s\n`);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("token lease failed");
}

async function resolveToken(env: NodeJS.ProcessEnv): Promise<string> {
  const fromEnv = env.IMSG_MCP_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const secretsBin = env.IMSG_MCP_SECRETS_BIN?.trim() || DEFAULT_SECRETS_BIN;
  return leaseTokenWithRetry(secretsBin);
}

async function main(): Promise<void> {
  const env = process.env;
  const portValue = env.IMSG_MCP_PORT;
  const port = portValue === undefined || portValue === "" ? DEFAULT_PORT : Number.parseInt(portValue, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("IMSG_MCP_PORT must be a valid TCP port");
  }
  const token = await resolveToken(env);
  const exec = createImsgExec({ bin: resolveImsgBin(env) });
  const version = await imsgVersion(exec);
  const server = await startImsgMcpHttpServer({ token, port, exec, version });
  process.stderr.write(`imsg-mcp: listening on ${DEFAULT_HOST}:${port} (imsg ${version ?? "unavailable"})\n`);

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
    process.stderr.write(`imsg-mcp: HTTP startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
