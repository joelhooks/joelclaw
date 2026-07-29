import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMessageEventLogClient,
  type MessageEventDocument,
} from "@joelclaw/message-event-log";
import { getRedisClient } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

// Settled 2026-07-29 in delivery-bar grilling:
// .brain/projects/agent-comms-gateway/decide-telegram-delivery-bar.svx
export const TARGET_DELIVERIES_PER_DAY = 12;
export const PAGE_THRESHOLD = 24;

export const DELIVERY_VOLUME_METER_CRON = "TZ=America/Los_Angeles 0 8 * * *";
export const DELIVERY_VOLUME_LATCH_KEY = "joelclaw:delivery-volume-meter:paged";
const DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const STREAM_PAGE_SIZE = 250;
const COUNTED_EVENT_KINDS = new Set(["delivery.requested", "fallback.delivered"]);

type TopSource = {
  source: string;
  count: number;
};

export type DeliveryVolumeReport = {
  windowStartedAt: number;
  windowEndedAt: number;
  count: number;
  topSources: TopSource[];
};

export type DeliveryVolumeOutcome = "paged" | "latched" | "quiet" | "latch-reset";

export type DeliveryVolumeRedis = {
  set(key: string, value: string, mode: "NX"): Promise<"OK" | null>;
  del(key: string): Promise<number>;
};

export type DeliveryVolumeMeterDependencies = {
  measure(): Promise<DeliveryVolumeReport>;
  claimPage(report: DeliveryVolumeReport): Promise<boolean>;
  resetLatch(): Promise<boolean>;
  releaseLatch(): Promise<void>;
  sendPage(report: DeliveryVolumeReport): Promise<void>;
  emitReport(report: DeliveryVolumeReport, outcome: DeliveryVolumeOutcome): Promise<void>;
  emitFailure(error: unknown): Promise<void>;
};

function deliverySource(event: MessageEventDocument): string {
  const producer = event.origin?.producer.trim();
  if (producer) return producer;
  const source = event.source.trim();
  return source || "unknown";
}

export function countDeliveryVolume(
  events: readonly MessageEventDocument[],
  windowEndedAt: number,
): DeliveryVolumeReport {
  const windowStartedAt = windowEndedAt - DELIVERY_WINDOW_MS;
  const sourceCounts = new Map<string, number>();
  let count = 0;

  for (const event of events) {
    if (!COUNTED_EVENT_KINDS.has(event.kind)) continue;
    if (event.occurredAt < windowStartedAt || event.occurredAt > windowEndedAt) continue;

    count += 1;
    const source = deliverySource(event);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }

  const topSources = [...sourceCounts.entries()]
    .map(([source, sourceCount]) => ({ source, count: sourceCount }))
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source))
    .slice(0, 3);

  return { windowStartedAt, windowEndedAt, count, topSources };
}

export async function measureDeliveryVolume(
  windowEndedAt = Date.now(),
): Promise<DeliveryVolumeReport> {
  const client = getMessageEventLogClient();
  const windowStartedAt = windowEndedAt - DELIVERY_WINDOW_MS;
  const events: MessageEventDocument[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = await client.readSince(windowStartedAt, STREAM_PAGE_SIZE, cursor);
    events.push(...page.events);
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) {
        throw new Error(`Message event log repeated cursor ${cursor}`);
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== null);

  return countDeliveryVolume(events, windowEndedAt);
}

export async function claimDeliveryVolumePage(
  redis: DeliveryVolumeRedis,
  report: DeliveryVolumeReport,
): Promise<boolean> {
  const result = await redis.set(
    DELIVERY_VOLUME_LATCH_KEY,
    JSON.stringify({
      pagedAt: report.windowEndedAt,
      count: report.count,
      topSources: report.topSources,
    }),
    "NX",
  );
  return result === "OK";
}

export async function clearDeliveryVolumeLatch(
  redis: DeliveryVolumeRedis,
): Promise<boolean> {
  return (await redis.del(DELIVERY_VOLUME_LATCH_KEY)) > 0;
}

function stableNotificationEventId(report: DeliveryVolumeReport): string {
  const hex = createHash("sha256")
    .update(`delivery-volume-meter:${report.windowEndedAt}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function pageMessage(report: DeliveryVolumeReport): string {
  const sources = report.topSources.length > 0
    ? report.topSources.map((source) => `- ${source.source}: ${source.count}`).join("\n")
    : "- unknown: 0";
  return [
    `Delivery volume is ${report.count} messages in the last 24 hours.`,
    `Target: ${TARGET_DELIVERIES_PER_DAY}. Page threshold: ${PAGE_THRESHOLD}.`,
    "Top sources:",
    sources,
  ].join("\n");
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCommand(args: readonly string[]): Promise<CommandResult> {
  const captureDir = await mkdtemp(join(tmpdir(), "delivery-volume-meter-"));
  const stdoutPath = join(captureDir, "stdout.txt");
  const stderrPath = join(captureDir, "stderr.txt");
  try {
    const proc = Bun.spawn([...args], {
      env: process.env,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8").catch(() => ""),
      readFile(stderrPath, "utf8").catch(() => ""),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
}

async function sendDeliveryVolumePage(report: DeliveryVolumeReport): Promise<void> {
  const eventId = stableNotificationEventId(report);
  const result = await runCommand([
    "joelclaw",
    "notify",
    "send",
    "--kind",
    "alert",
    "--priority",
    "high",
    "--source",
    "delivery-volume-meter",
    "--event-id",
    eventId,
    pageMessage(report),
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `joelclaw notify send exited ${result.exitCode}: ${result.stderr || result.stdout || "no output"}`,
    );
  }

  let envelope: { ok?: boolean; result?: { eventId?: string }; error?: { message?: string } };
  try {
    envelope = JSON.parse(result.stdout) as typeof envelope;
  } catch {
    throw new Error("joelclaw notify send returned non-JSON output");
  }
  if (envelope.ok !== true || envelope.result?.eventId !== eventId) {
    throw new Error(
      `joelclaw notify send failed: ${envelope.error?.message ?? "unexpected event receipt"}`,
    );
  }
}

async function emitDeliveryVolumeReport(
  report: DeliveryVolumeReport,
  outcome: DeliveryVolumeOutcome,
): Promise<void> {
  await emitOtelEvent({
    level: outcome === "paged" ? "warn" : "info",
    source: "worker",
    component: "delivery-volume-meter",
    action: outcome === "paged"
      ? "gateway.delivery_volume.paged"
      : outcome === "latch-reset"
        ? "gateway.delivery_volume.latch_reset"
        : "gateway.delivery_volume.measured",
    success: true,
    metadata: {
      ...report,
      target: TARGET_DELIVERIES_PER_DAY,
      pageThreshold: PAGE_THRESHOLD,
      outcome,
    },
  });
}

async function emitDeliveryVolumeFailure(error: unknown): Promise<void> {
  await emitOtelEvent({
    level: "error",
    source: "worker",
    component: "delivery-volume-meter",
    action: "gateway.delivery_volume.failed",
    success: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

const defaultDependencies: DeliveryVolumeMeterDependencies = {
  measure: () => measureDeliveryVolume(),
  claimPage: (report) =>
    claimDeliveryVolumePage(getRedisClient() as DeliveryVolumeRedis, report),
  resetLatch: () => clearDeliveryVolumeLatch(getRedisClient() as DeliveryVolumeRedis),
  releaseLatch: async () => {
    await clearDeliveryVolumeLatch(getRedisClient() as DeliveryVolumeRedis);
  },
  sendPage: sendDeliveryVolumePage,
  emitReport: emitDeliveryVolumeReport,
  emitFailure: emitDeliveryVolumeFailure,
};

export function createDeliveryVolumeMeterFunction(
  dependencies: DeliveryVolumeMeterDependencies = defaultDependencies,
) {
  return inngest.createFunction(
    {
      id: "gateway/delivery-volume-meter",
      name: "Gateway: Delivery Volume Meter",
      concurrency: { limit: 1 },
      singleton: { key: '"global"', mode: "skip" },
      onFailure: async ({ error, step }) => {
        await step.run("emit-delivery-volume-failure", () => dependencies.emitFailure(error));
      },
    },
    { cron: DELIVERY_VOLUME_METER_CRON },
    async ({ step }) => {
      // Only this body-free aggregate enters Inngest run state.
      const report = await step.run("measure-delivery-volume", () => dependencies.measure());
      let outcome: DeliveryVolumeOutcome = "quiet";

      if (report.count <= TARGET_DELIVERIES_PER_DAY) {
        // This rolling window proves a full day at or under target before reset.
        const reset = await step.run("reset-delivery-volume-latch", () =>
          dependencies.resetLatch(),
        );
        outcome = reset ? "latch-reset" : "quiet";
      } else if (report.count >= PAGE_THRESHOLD) {
        const claimed = await step.run("claim-delivery-volume-page", () =>
          dependencies.claimPage(report),
        );
        if (claimed) {
          await step.run("send-delivery-volume-page", async () => {
            try {
              await dependencies.sendPage(report);
            } catch (error) {
              await dependencies.releaseLatch().catch(() => undefined);
              throw error;
            }
          });
          outcome = "paged";
        } else {
          outcome = "latched";
        }
      }

      await step.run("emit-delivery-volume-report", () =>
        dependencies.emitReport(report, outcome),
      );

      return {
        ...report,
        target: TARGET_DELIVERIES_PER_DAY,
        pageThreshold: PAGE_THRESHOLD,
        outcome,
      };
    },
  );
}

export const deliveryVolumeMeter = createDeliveryVolumeMeterFunction();
