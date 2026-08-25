import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const collect = async (stream: NodeJS.ReadableStream | null) => {
  if (stream === null) return "";
  stream.setEncoding("utf8");
  let output = "";
  for await (const chunk of stream) output += String(chunk);
  return output;
};

const run = async (command: string, arguments_: readonly string[]) => {
  const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
  const [stdout, stderr, close] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    once(child, "close"),
  ]);
  if (close[0] !== 0) throw new Error(`${command} failed: ${stderr}`);
  return stdout;
};

const availablePort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    await server[Symbol.asyncDispose]();
    throw new Error("test-postgres-port-unavailable");
  }
  await server[Symbol.asyncDispose]();
  return address.port;
};

export interface PostgresTestCluster {
  readonly migrationUrl: string;
  readonly runtimeUrl: string;
  readonly stop: () => Promise<void>;
}

export const startPostgresTestCluster = async (): Promise<PostgresTestCluster> => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-producer-pg17-"));
  const data = path.join(directory, "data");
  const socket = path.join(directory, "socket");
  const log = path.join(directory, "postgres.log");
  const port = await availablePort();
  let started = false;
  try {
    if (!(await run("initdb", ["--version"])).startsWith("initdb (PostgreSQL) 17.")) {
      throw new Error("postgres-17-required");
    }
    await mkdir(socket);
    await run("initdb", [
      "--pgdata",
      data,
      "--username=memory_admin",
      "--auth=trust",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    await run("pg_ctl", [
      "--pgdata",
      data,
      "--log",
      log,
      "--options",
      `-F -p ${port} -h 127.0.0.1 -k ${socket}`,
      "--wait",
      "start",
    ]);
    started = true;
    const adminUrl = `postgresql://memory_admin@127.0.0.1:${port}/postgres`;
    await run("psql", [
      adminUrl,
      "--set=ON_ERROR_STOP=1",
      "--command",
      `CREATE ROLE joelclaw_memory_migrator LOGIN;
       CREATE ROLE joelclaw_memory_runtime LOGIN;
       REVOKE ALL ON SCHEMA public FROM PUBLIC, joelclaw_memory_runtime;
       ALTER SCHEMA public OWNER TO joelclaw_memory_migrator;
       GRANT USAGE, CREATE ON SCHEMA public TO joelclaw_memory_migrator;
       GRANT USAGE ON SCHEMA public TO joelclaw_memory_runtime;`,
    ]);
  } catch (error) {
    const details = await readFile(log, "utf8").catch(() => "");
    if (started) {
      await run("pg_ctl", ["--pgdata", data, "--wait", "--mode=fast", "stop"]).catch(
        () => undefined,
      );
    }
    await rm(directory, { recursive: true, force: true });
    throw new Error(`test-postgres-start-failed:${details.length}`, { cause: error });
  }

  let stopped = false;
  return {
    migrationUrl: `postgresql://joelclaw_memory_migrator@127.0.0.1:${port}/postgres`,
    runtimeUrl: `postgresql://joelclaw_memory_runtime@127.0.0.1:${port}/postgres`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await run("pg_ctl", ["--pgdata", data, "--wait", "--mode=fast", "stop"]);
      await rm(directory, { recursive: true, force: true });
    },
  };
};
