import type { Database } from "bun:sqlite";
import { appendCapture } from "./append";
import type { CellConfig } from "./config";
import { createDrain, type Drain, type WalCheck } from "./drain";
import { createOtelShipper } from "./otel";
import { openOutbox } from "./outbox";
import { createCellHandler } from "./server";
import { shadowAppend, walBytes } from "./shadow-append";

export interface CellRuntime {
  db: Database;
  drain: Drain;
  port: number;
  stop(): void;
}

export function walCheckFor(sessionsDbPath: string, limitBytes: number): () => WalCheck {
  return () => {
    const bytes = walBytes(sessionsDbPath);
    return bytes > limitBytes
      ? { paused: true, wal_bytes: bytes, limit_bytes: limitBytes }
      : { paused: false };
  };
}

/** Open the outbox, start the drain (boot drains anything owed) and listen on loopback. */
export function startCell(config: CellConfig & { port: number; token: string }): CellRuntime {
  const db = openOutbox(config.outboxPath);
  const now = () => Date.now();
  const drain = createDrain({
    db,
    now,
    appendStep: (payload, marker) => {
      const options = {
        sessionsDbPath: config.sessionsDbPath,
        readTimeoutMs: config.readTimeoutMs,
      };
      return marker.writer
        ? appendCapture(payload, options, now())
        : shadowAppend(payload, options);
    },
    mode: config.mode,
    slots: config.mode === "cell" ? { otel: 3 } : undefined,
    shipOtel: createOtelShipper(config.otel),
    walCheck: walCheckFor(config.sessionsDbPath, config.walStopBytes),
    tickMs: config.tickMs,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    fetch: createCellHandler({
      db,
      drain,
      token: config.token,
      now,
      mode: config.mode === "cell" ? "cell" : "shadow",
    }),
  });
  drain.kick();
  return {
    db,
    drain,
    port: server.port ?? config.port,
    stop() {
      drain.stop();
      server.stop(true);
      db.close(false);
    },
  };
}
