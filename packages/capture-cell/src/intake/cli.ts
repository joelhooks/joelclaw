#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { closeSessionIndexConnections, migrateSessionIndex } from "@joelclaw/memory";
import { createIntakeIdentities, exportIdentities } from "./identities";
import { createLegacySender, drainRemoteToLegacy, transferRemoteBack } from "./legacy";
import { createIntakeHandler } from "./server";
import { intakeHealth, openIntake, pruneIntake, sweepOrphanBlobs } from "./store";
import { MAX_INTAKE_BYTES } from "./stream";

const usage = `capture-intake serve
capture-intake append [--compare-only] [--once]
capture-intake status
capture-intake prune
capture-intake drain-to-legacy [--dry-run] [--json]
capture-intake transfer-back [--dry-run] [--json]
capture-intake identities-export --db <central-auth-db>
capture-intake index-migrate --db <sessions-db>

Serve requires CAPTURE_CELL_MODE=intake, CAPTURE_INTAKE_TOKEN,
CAPTURE_INTAKE_PULL_TOKEN, CAPTURE_INTAKE_USER_ID. Shared ingest-token requests need payload machine_id; identities supply it.
CAPTURE_INTAKE_IDENTITIES_FILE optionally accepts Central machine-token hashes; reloads on SIGHUP or file change.
Identities export reads only an existing Central auth DB: RUN_CAPTURE_AUTH_DATABASE or ~/.joelclaw/capture-auth.db.
CAPTURE_INTAKE_DIR selects blob/outbox storage. CAPTURE_CELL_PORT defaults 3114;
CAPTURE_INTAKE_BIND defaults wildcard. Serve never opens sessions.db.
CAPTURE_INTAKE_BLOB_DIR and CAPTURE_INTAKE_DB override the separate storage paths.
Append needs CAPTURE_INTAKE_URL, CAPTURE_INTAKE_PULL_TOKEN, SESSION_INDEX_PATH.
Writer mode requires CAPTURE_APPENDER_MODE=writer; otherwise use --compare-only.
Drain needs CAPTURE_LEGACY_URL/TOKEN unless --dry-run.
Set CAPTURE_INTAKE_URL/PULL_TOKEN to drain remotely from the appender host; no outbound access from intake is needed.
Transfer-back requires the intake URL/pull token; stop drains first. It restores legacy debt to appender discovery.
No command deploys services.
`;
function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} required`);
  return value;
}
export async function main(args: string[], env = process.env): Promise<number> {
  const [command, ...flags] = args;
  if (!command || command === "--help") {
    console.log(usage);
    return 0;
  }
  if (command === "index-migrate") {
    if (flags.length !== 2 || flags[0] !== "--db" || !flags[1] || flags[1].startsWith("--"))
      throw new Error("usage: capture-intake index-migrate --db <sessions-db>");
    console.log(JSON.stringify(migrateSessionIndex(flags[1])));
    return 0;
  }
  if (command === "identities-export") {
    if (flags.length !== 2 || flags[0] !== "--db" || !flags[1] || flags[1].startsWith("--"))
      throw new Error("usage: capture-intake identities-export --db <central-auth-db>");
    console.log(JSON.stringify(exportIdentities(flags[1])));
    return 0;
  }
  if (
    !["serve", "append", "status", "prune", "drain-to-legacy", "transfer-back"].includes(command) ||
    flags.some((flag) => !["--compare-only", "--once", "--dry-run", "--json"].includes(flag)) ||
    flags.some((flag) =>
      command === "append"
        ? !["--compare-only", "--once"].includes(flag)
        : ["drain-to-legacy", "transfer-back"].includes(command)
          ? !["--dry-run", "--json"].includes(flag)
          : true,
    )
  )
    throw new Error(usage);
  const root = env.CAPTURE_INTAKE_DIR?.trim() || join(homedir(), ".joelclaw", "capture-intake");
  if (command === "append") {
    const compareOnly = flags.includes("--compare-only");
    if (!compareOnly && env.CAPTURE_APPENDER_MODE !== "writer")
      throw new Error("writer requires CAPTURE_APPENDER_MODE=writer (or use --compare-only)");
    const { createAppender } = await import("./appender");
    const { emitGatewayOtel } = await import("@joelclaw/telemetry");
    const appender = createAppender({
      url: required(env, "CAPTURE_INTAKE_URL"),
      token: required(env, "CAPTURE_INTAKE_PULL_TOKEN"),
      runDir: env.CAPTURE_APPENDER_DIR || join(root, "indexed-blobs"),
      sessionsDbPath: required(env, "SESSION_INDEX_PATH"),
      compareOnly,
      observe: (row, observation) =>
        console.log(JSON.stringify({ run_id: row.run_id, compareOnly, ...observation })),
      telemetry: {
        emit: (action, detail, extra) => {
          console.log(JSON.stringify({ action, detail, ...extra }));
          const replaced = action === "capture.intake.appender.session_index_replaced";
          const missingIndex = action === "capture.session_index.cursor_index_missing";
          const loadGated = action === "capture.intake.appender.load_gated";
          const warning = missingIndex || loadGated;
          if (action === "memory.run.session-index.append" || replaced || warning) {
            void emitGatewayOtel({
              level: replaced ? "error" : warning ? "warn" : "info",
              source: "capture-appender",
              component: "capture-appender",
              action,
              success: !replaced && !warning,
              error: replaced
                ? "SESSION_INDEX_REPLACED"
                : missingIndex
                  ? "cursor_index_missing"
                  : loadGated
                    ? "load_gated"
                    : undefined,
              // ClickHouse duration is UInt32; keep sub-ms precision only in metadata.
              duration_ms: replaced || warning ? undefined : Math.round(Number(extra?.duration_ms)),
              metadata: { detail, ...extra },
            });
          }
        },
      },
    });
    try {
      if (flags.includes("--once")) {
        const result = await appender.tick();
        console.log(JSON.stringify(result));
        return result.failed ? 1 : 0;
      }
      const controller = new AbortController();
      const stop = () => controller.abort();
      // Keep listeners registered while the canonical cache's signal hook closes handles.
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      try {
        await appender.run(controller.signal);
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
      return 0;
    } finally {
      closeSessionIndexConnections();
    }
  }
  if (command === "serve" && env.CAPTURE_CELL_MODE !== "intake")
    throw new Error("serve requires CAPTURE_CELL_MODE=intake");
  // Validate configuration before touching the store.
  const serverOptions =
    command === "serve"
      ? {
          ingestToken: required(env, "CAPTURE_INTAKE_TOKEN"),
          pullToken: required(env, "CAPTURE_INTAKE_PULL_TOKEN"),
          principal: { user_id: required(env, "CAPTURE_INTAKE_USER_ID") },
          identities: env.CAPTURE_INTAKE_IDENTITIES_FILE?.trim()
            ? createIntakeIdentities(env.CAPTURE_INTAKE_IDENTITIES_FILE.trim())
            : undefined,
        }
      : null;
  const sender =
    command === "drain-to-legacy" && !flags.includes("--dry-run")
      ? createLegacySender({
          url: required(env, "CAPTURE_LEGACY_URL"),
          token: required(env, "CAPTURE_LEGACY_TOKEN"),
        })
      : undefined;
  if (command === "transfer-back") {
    const result = await transferRemoteBack({
      url: required(env, "CAPTURE_INTAKE_URL"),
      token: required(env, "CAPTURE_INTAKE_PULL_TOKEN"),
      dryRun: flags.includes("--dry-run"),
    });
    console.log(JSON.stringify(result));
    return result.failed.length ? 1 : 0;
  }
  if (command === "drain-to-legacy") {
    const result = await drainRemoteToLegacy({
      url: required(env, "CAPTURE_INTAKE_URL"),
      token: required(env, "CAPTURE_INTAKE_PULL_TOKEN"),
      runDir: env.CAPTURE_APPENDER_DIR || join(root, "legacy-staging"),
      dryRun: flags.includes("--dry-run"),
      send: sender,
    });
    console.log(JSON.stringify(result));
    return result.failed.length ? 1 : 0;
  }
  const store = openIntake(root, {
    blobDir: env.CAPTURE_INTAKE_BLOB_DIR,
    dbPath: env.CAPTURE_INTAKE_DB,
  });
  try {
    if (command === "serve") {
      const port = Number(env.CAPTURE_CELL_PORT ?? 3114);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
        throw new Error("invalid CAPTURE_CELL_PORT");
      const server = Bun.serve({
        hostname: env.CAPTURE_INTAKE_BIND || "0.0.0.0",
        port,
        idleTimeout: 255,
        maxRequestBodySize: MAX_INTAKE_BYTES,
        fetch: createIntakeHandler({ store, ...serverOptions! }),
      });
      const pruner = setInterval(() => {
        try {
          pruneIntake(store);
          sweepOrphanBlobs(store);
        } catch {
          console.error("capture intake prune failed; retaining remaining blobs");
        }
      }, 60_000);
      pruner.unref();
      const stop = Promise.withResolvers<void>();
      const shutdown = () => {
        void server.stop(true).then(() => stop.resolve());
      };
      const reloadIdentities = () => serverOptions!.identities?.reload(true);
      process.on("SIGHUP", reloadIdentities);
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      console.log(JSON.stringify({ mode: "intake", port: server.port }));
      try {
        await stop.promise;
      } finally {
        clearInterval(pruner);
        process.off("SIGHUP", reloadIdentities);
        process.off("SIGTERM", shutdown);
        process.off("SIGINT", shutdown);
      }
      return 0;
    }
    if (command === "status") {
      console.log(JSON.stringify(intakeHealth(store)));
      return 0;
    }
    if (command === "prune") {
      console.log(JSON.stringify({ pruned: pruneIntake(store), orphans: sweepOrphanBlobs(store) }));
      return 0;
    }
    throw new Error("unsupported intake command");
  } finally {
    store.close();
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
