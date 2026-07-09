import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type OtelEvent } from "./otel-event";
import { writeClickHouseOtelEvents } from "./clickhouse-store";

const DEFAULT_OUTBOX_DIR = `${process.env.HOME ?? "/tmp"}/.joelclaw/spool/otel`;
const DEFAULT_DRAIN_LIMIT = 100;

type QueuedEvent = {
  event: OtelEvent;
  queuedAt: number;
};

export type OutboxEnqueueResult = {
  queued: boolean;
  path?: string;
  error?: string;
};

export type OutboxDrainResult = {
  drained: number;
  failed: number;
  error?: string;
};

export function resolveOtelOutboxDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OTEL_OUTBOX_DIR ?? DEFAULT_OUTBOX_DIR;
}

function queuedName(event: OtelEvent): string {
  const timestamp = String(event.timestamp || Date.now()).padStart(13, "0");
  return `${timestamp}-${event.id || randomUUID()}.json`;
}

async function listQueuedFiles(dir: string, limit: number): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const names = await readdir(dir);
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .slice(0, limit)
    .map((name) => join(dir, name));
}

export async function enqueueOtelOutboxEvent(
  event: OtelEvent,
  dir = resolveOtelOutboxDir()
): Promise<OutboxEnqueueResult> {
  try {
    await mkdir(dir, { recursive: true });
    const finalPath = join(dir, queuedName(event));
    const tempPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
    const payload: QueuedEvent = { event, queuedAt: Date.now() };
    await writeFile(tempPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, finalPath);
    return { queued: true, path: finalPath };
  } catch (error) {
    return { queued: false, error: String(error) };
  }
}

let drainInFlight: Promise<OutboxDrainResult> | null = null;

export async function drainOtelOutbox(
  options: { dir?: string; limit?: number } = {}
): Promise<OutboxDrainResult> {
  if (drainInFlight) return drainInFlight;

  drainInFlight = (async () => {
    const dir = options.dir ?? resolveOtelOutboxDir();
    const limit = options.limit ?? DEFAULT_DRAIN_LIMIT;
    const files = await listQueuedFiles(dir, limit);
    if (files.length === 0) return { drained: 0, failed: 0 };

    const processing: string[] = [];
    for (const file of files) {
      const processingPath = `${file}.processing`;
      try {
        await rename(file, processingPath);
        processing.push(processingPath);
      } catch {
        // Another process may have grabbed it. Fine.
      }
    }

    const events: OtelEvent[] = [];
    const unreadable: string[] = [];
    for (const file of processing) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<QueuedEvent>;
        if (parsed.event) events.push(parsed.event);
        else unreadable.push(file);
      } catch {
        unreadable.push(file);
      }
    }

    for (const file of unreadable) {
      await rm(file, { force: true });
    }

    if (events.length === 0) {
      return { drained: 0, failed: unreadable.length };
    }

    const result = await writeClickHouseOtelEvents(events);
    if (!result.written) {
      for (const file of processing) {
        await rename(file, file.replace(/\.processing$/u, "")).catch(() => {});
      }
      return { drained: 0, failed: events.length, error: result.error };
    }

    for (const file of processing) {
      await rm(file, { force: true });
    }

    return { drained: events.length, failed: unreadable.length };
  })().finally(() => {
    drainInFlight = null;
  });

  return drainInFlight;
}
