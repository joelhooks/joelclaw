#!/usr/bin/env bun
import { collectAlerts } from "./alerts";
import { type CellRuntime, startCell } from "./cell";
import { compare, compareIndexToCell, formatCompareReport } from "./compare";
import { loadConfig } from "./config";
import { createHandbackSender, handback } from "./handback";
import { openOutbox, readHealth, replay } from "./outbox";

const USAGE = `capture-cell: the capture ingest cell

Usage:
  capture-cell serve                      Run the HTTP cell and its drain
  capture-cell status [--alerts] [--json] Outbox depth, oldest owed age, dead rows, WAL pause
  capture-cell replay <run_id>            Owe a run's steps again (revives dead markers)
  capture-cell handback [--dry-run] [--json]
                                          Transfer owed appends to Inngest, preserving run ids
  capture-cell compare --since <iso> [--direction cell-to-index|index-to-cell] [--json]
                                          Compare in either direction (short read transactions)

Environment:
  CAPTURE_CELL_MODE               cell writes the index; off/both only shadow
  INNGEST_URL, INNGEST_EVENT_KEY   required only for handback (not dry-run)
  CAPTURE_CELL_DB                 outbox path (default ~/.joelclaw/capture-cell/outbox.db)
  SESSION_INDEX_PATH              sessions.db path (default ~/.joelclaw/search/sessions.db)
  CAPTURE_CELL_PORT               loopback port for serve (required for serve)
  CAPTURE_CELL_TOKEN              bearer token for POST /capture (required for serve)
  CAPTURE_CELL_READ_TIMEOUT_MS    shadow read bound (default 3000)
  CAPTURE_CELL_WAL_STOP_BYTES     pause shadowing above this WAL size (default 2 GiB)
  OTEL_EMIT_URL | JOELCLAW_CENTRAL_URL, OTEL_EMIT_TOKEN   where verdict events go
`;

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  if (process.env.CAPTURE_CELL_MODE === "intake") {
    const intake = await import("./intake/cli");
    return intake.main(argv);
  }
  const [command, ...args] = argv;
  const config = loadConfig();

  if (command === "serve") {
    if (config.port === undefined || !config.token) {
      console.error("capture-cell serve needs CAPTURE_CELL_PORT and CAPTURE_CELL_TOKEN");
      return 2;
    }
    const cell: CellRuntime = startCell({ ...config, port: config.port, token: config.token });
    console.log(
      `[capture-cell] listening on 127.0.0.1:${cell.port} (${config.mode === "cell" ? "writer" : "shadow"} mode)`,
    );
    const shutdown = () => {
      cell.stop();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    await new Promise(() => undefined);
    return 0;
  }

  if (command === "status") {
    const db = openOutbox(config.outboxPath);
    try {
      const now = Date.now();
      if (flag(args, "--alerts")) {
        for (const line of collectAlerts(db, now)) console.log(line);
        return 0;
      }
      const health = readHealth(db, now, config.mode === "cell" ? "cell" : "shadow");
      console.log(flag(args, "--json") ? JSON.stringify(health) : formatHealth(health));
      return 0;
    } finally {
      db.close(false);
    }
  }

  if (command === "replay") {
    const runId = args[0];
    if (!runId) {
      console.error("usage: capture-cell replay <run_id>");
      return 2;
    }
    const db = openOutbox(config.outboxPath);
    try {
      if (!replay(db, runId, Date.now())) {
        console.error(
          `capture-cell: run ${runId} was never captured or belongs to Inngest after handback`,
        );
        return 1;
      }
      console.log(
        `capture-cell: run ${runId} owes append and otel again; the serving cell drains it`,
      );
      return 0;
    } finally {
      db.close(false);
    }
  }

  if (command === "handback") {
    if (args.some((arg) => arg !== "--dry-run" && arg !== "--json")) {
      console.error("usage: capture-cell handback [--dry-run] [--json]");
      return 2;
    }
    const dryRun = flag(args, "--dry-run");
    if (
      !dryRun &&
      (!(process.env.INNGEST_URL ?? process.env.INNGEST_BASE_URL) || !process.env.INNGEST_EVENT_KEY)
    ) {
      console.error(
        "capture-cell handback needs INNGEST_URL and INNGEST_EVENT_KEY (or use --dry-run)",
      );
      return 2;
    }
    const db = openOutbox(config.outboxPath);
    try {
      const report = await handback(db, { dryRun, send: createHandbackSender() });
      console.log(
        flag(args, "--json")
          ? JSON.stringify(report)
          : `capture-cell handback${dryRun ? " (dry-run)" : ""}: ${report.runs.length} runs, ${report.sent.length} sent, ${report.failed.length} failed`,
      );
      return report.failed.length > 0 ? 1 : 0;
    } finally {
      db.close(false);
    }
  }

  if (command === "compare") {
    const sinceText = option(args, "--since");
    const since = sinceText ? Date.parse(sinceText) : Number.NaN;
    if (!Number.isFinite(since)) {
      console.error("usage: capture-cell compare --since <iso>");
      return 2;
    }
    const direction = option(args, "--direction") ?? "cell-to-index";
    if (direction !== "cell-to-index" && direction !== "index-to-cell") {
      console.error("capture-cell compare --direction must be cell-to-index or index-to-cell");
      return 2;
    }
    const db = openOutbox(config.outboxPath);
    try {
      const runCompare = direction === "index-to-cell" ? compareIndexToCell : compare;
      const report = runCompare(db, config.sessionsDbPath, since, Date.now(), config.readTimeoutMs);
      console.log(flag(args, "--json") ? JSON.stringify(report) : formatCompareReport(report));
      return 0;
    } finally {
      db.close(false);
    }
  }

  console.log(USAGE);
  return command === undefined || command === "--help" || command === "help" ? 0 : 2;
}

function formatHealth(health: ReturnType<typeof readHealth>): string {
  const age =
    health.oldest_owed_age_ms === null
      ? "none"
      : `${Math.round(health.oldest_owed_age_ms / 1000)}s`;
  const wal = health.wal_paused
    ? `paused since ${new Date(health.wal_paused.since).toISOString()}: ${health.wal_paused.reason}`
    : "ok";
  return `capture-cell: ${health.depth} owed, oldest ${age}, ${health.dead} dead, ${health.verdicts} verdicts, WAL ${wal}`;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
