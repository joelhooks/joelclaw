import { $ } from "bun";
import Redis from "ioredis";
import { NonRetriableError } from "inngest";
import { join, parse } from "node:path";
import { inngest } from "../client";
import { emitMeasuredOtelEvent } from "../../observability/emit";
import { pushGatewayEvent } from "./agent-loop/utils";

const DARK_WIZARD = "joel@100.86.171.79";
const CLANKER = "joel@100.95.167.75";
const THREE_BODY = "/Volumes/three-body";
const MANIFEST_PATH = `${process.env.HOME}/Documents/manifest.clean.jsonl`;
const REDIS_KEY = "manifest:archive:state";
const BATCH_SIZE = 48;

type ManifestEntry = {
  id: string;
  filename: string;
  sourcePath: string;
  sourceExists: boolean;
  enrichmentCategory: string | null;
  enrichmentDocumentType: string | null;
  sourceFileType: string;
  sourceSizeBytes?: number;
};

type ArchivePlanItem = {
  id: string;
  src: string;
  dest: string;
  bytes: number;
};

type ArchiveBatchResult = {
  scanned: number;
  wouldCopy: number;
  wouldSkip: number;
  failed: number;
  totalBytes: number;
  plan: ArchivePlanItem[];
};

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8").trim();
  return String(value ?? "").trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBytes(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function isCopiedState(raw: string | null): boolean {
  if (!raw) return false;
  if (raw === "copied") return true;
  try {
    const parsed = JSON.parse(raw) as { status?: string };
    return parsed.status === "copied";
  } catch {
    return false;
  }
}

export function sanitizeFilename(raw: string): string {
  const parsed = parse(raw || "");
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 20);
  const maxBaseLength = Math.max(1, 200 - ext.length);

  let base = (parsed.name || "document")
    .replace(/[^a-zA-Z0-9.\s_-]/g, " ")
    .replace(/[\s-]+/g, "-")
    .replace(/_+/g, "_")
    .replace(/\.+/g, ".")
    .replace(/^[-_.]+|[-_.]+$/g, "");

  if (!base) base = "document";
  if (base.length > maxBaseLength) {
    base = base.slice(0, maxBaseLength).replace(/^[-_.]+|[-_.]+$/g, "");
  }
  if (!base) base = "document";

  return `${base}${ext}`;
}

export function getCategoryDir(category: string | null): string {
  const normalized = category?.trim().toLowerCase();
  switch (normalized) {
    case "programming":
    case "business":
    case "education":
    case "design":
    case "other":
      return normalized;
    default:
      return "uncategorized";
  }
}

export function getDestPath(entry: ManifestEntry): string {
  const filename = sanitizeFilename(entry.filename);
  if (entry.sourcePath.includes("/clawd/podcasts/")) {
    return join(THREE_BODY, "podcasts", filename);
  }
  return join(THREE_BODY, "books", getCategoryDir(entry.enrichmentCategory), filename);
}

async function* readJsonlLines(file: Blob): AsyncGenerator<{ line: string; lineNumber: number }> {
  const decoder = new TextDecoder();
  const reader = file.stream().getReader();
  let buffer = "";
  let lineNumber = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const splitAt = buffer.indexOf("\n");
        if (splitAt < 0) break;
        const line = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 1);
        lineNumber += 1;
        yield { line, lineNumber };
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      lineNumber += 1;
      yield { line: buffer, lineNumber };
    }
  } finally {
    reader.releaseLock();
  }
}

function parseManifestEntry(raw: unknown, lineNumber: number): ManifestEntry {
  if (!raw || typeof raw !== "object") {
    throw new NonRetriableError(`Manifest entry at line ${lineNumber} is not an object`);
  }

  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const filename = typeof value.filename === "string" ? value.filename.trim() : "";
  const sourcePath = typeof value.sourcePath === "string" ? value.sourcePath.trim() : "";

  if (!id || !filename || !sourcePath) {
    throw new NonRetriableError(
      `Manifest entry at line ${lineNumber} is missing required id/filename/sourcePath`
    );
  }

  return {
    id,
    filename,
    sourcePath,
    sourceExists: Boolean(value.sourceExists),
    enrichmentCategory:
      typeof value.enrichmentCategory === "string" ? value.enrichmentCategory : null,
    enrichmentDocumentType:
      typeof value.enrichmentDocumentType === "string" ? value.enrichmentDocumentType : null,
    sourceFileType:
      typeof value.sourceFileType === "string" && value.sourceFileType.trim().length > 0
        ? value.sourceFileType
        : "unknown",
    sourceSizeBytes: normalizeBytes(value.sourceSizeBytes),
  };
}

async function loadManifest(): Promise<ManifestEntry[]> {
  const file = Bun.file(MANIFEST_PATH);
  if (!(await file.exists())) {
    throw new NonRetriableError(`Manifest not found at ${MANIFEST_PATH}`);
  }

  const entries: ManifestEntry[] = [];
  for await (const { line, lineNumber } of readJsonlLines(file)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new NonRetriableError(
        `Invalid JSON in manifest at line ${lineNumber}: ${formatError(error)}`
      );
    }

    entries.push(parseManifestEntry(parsed, lineNumber));
  }

  return entries;
}

export const manifestArchive = inngest.createFunction(
  {
    id: "manifest-archive",
    singleton: { key: '"global"', mode: "skip" },
    concurrency: { limit: 1 },
    retries: 3,
  },
  [{ event: "manifest/archive.requested" }],
  async ({ event, step }) => {
    const dryRun = event.data.dryRun ?? true;
    if (!dryRun) {
      throw new NonRetriableError("manifest-archive is dry-run only; set dryRun=true");
    }

    await step.run("validate-prereqs", async () => {
      const nasCheck = await $`ls ${THREE_BODY}`.quiet().nothrow();
      if (nasCheck.exitCode !== 0) {
        throw new NonRetriableError(
          `NAS mount is not accessible at ${THREE_BODY}: ${toText(nasCheck.stderr || nasCheck.stdout)}`
        );
      }

      for (const host of [DARK_WIZARD, CLANKER]) {
        const sshCheck = await $`ssh -o BatchMode=yes -o ConnectTimeout=5 ${host} echo ok`
          .quiet()
          .nothrow();
        if (sshCheck.exitCode !== 0) {
          throw new NonRetriableError(
            `SSH prereq failed for ${host}: ${toText(sshCheck.stderr || sshCheck.stdout)}`
          );
        }
      }
    });

    const manifestEntries = await step.run("load-manifest", async () => {
      return loadManifest();
    });

    const aggregate: ArchiveBatchResult = {
      scanned: 0,
      wouldCopy: 0,
      wouldSkip: 0,
      failed: 0,
      totalBytes: 0,
      plan: [],
    };

    const batchCount = Math.ceil(manifestEntries.length / BATCH_SIZE);

    for (let i = 0; i < manifestEntries.length; i += BATCH_SIZE) {
      const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
      const batch = manifestEntries.slice(i, i + BATCH_SIZE);

      const batchResult = await step.run(`plan-copy-batch-${batchIndex}`, async () => {
        const redis = getRedis();
        const result: ArchiveBatchResult = {
          scanned: 0,
          wouldCopy: 0,
          wouldSkip: 0,
          failed: 0,
          totalBytes: 0,
          plan: [],
        };

        for (const entry of batch) {
          result.scanned += 1;
          try {
            const copiedState = await redis.hget(REDIS_KEY, entry.id);
            if (isCopiedState(copiedState)) {
              result.wouldSkip += 1;
              console.log(`[manifest-archive] would-skip id=${entry.id} status=copied`);
              continue;
            }

            const srcHost = entry.sourceExists ? DARK_WIZARD : CLANKER;
            const src = `${srcHost}:${entry.sourcePath}`;
            const dest = getDestPath(entry);
            const bytes = normalizeBytes(entry.sourceSizeBytes);
            const planItem: ArchivePlanItem = { id: entry.id, src, dest, bytes };

            result.wouldCopy += 1;
            result.totalBytes += bytes;
            result.plan.push(planItem);
            console.log("[manifest-archive] would-copy", planItem);
          } catch (error) {
            result.failed += 1;
            console.error(
              `[manifest-archive] plan error id=${entry.id}: ${formatError(error)}`
            );
          }
        }

        return result;
      });

      aggregate.scanned += batchResult.scanned;
      aggregate.wouldCopy += batchResult.wouldCopy;
      aggregate.wouldSkip += batchResult.wouldSkip;
      aggregate.failed += batchResult.failed;
      aggregate.totalBytes += batchResult.totalBytes;
      aggregate.plan.push(...batchResult.plan);
    }

    await step.sendEvent("emit-plan", {
      name: "manifest/archive.completed",
      data: {
        dryRun,
        scanned: aggregate.scanned,
        wouldCopy: aggregate.wouldCopy,
        wouldSkip: aggregate.wouldSkip,
        failed: aggregate.failed,
        totalBytes: aggregate.totalBytes,
        plan: aggregate.plan,
      },
    });

    await step.run("push-gateway-event", async () => {
      try {
        await pushGatewayEvent({
          type: "manifest.archive.dry-run.completed",
          source: "inngest",
          payload: {
            dryRun,
            reason: event.data.reason ?? null,
            scanned: aggregate.scanned,
            wouldCopy: aggregate.wouldCopy,
            wouldSkip: aggregate.wouldSkip,
            failed: aggregate.failed,
            totalBytes: aggregate.totalBytes,
            batches: batchCount,
            batchSize: BATCH_SIZE,
          },
        });
      } catch (error) {
        console.error(
          `[manifest-archive] gateway event failed: ${formatError(error)}`
        );
      }
    });

    await step.run("emit-otel", async () => {
      await emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "manifest-archive",
          action: "manifest.archive.dry-run.completed",
          metadata: {
            dryRun,
            reason: event.data.reason ?? null,
            scanned: aggregate.scanned,
            wouldCopy: aggregate.wouldCopy,
            wouldSkip: aggregate.wouldSkip,
            failed: aggregate.failed,
            totalBytes: aggregate.totalBytes,
            batches: batchCount,
            batchSize: BATCH_SIZE,
          },
        },
        async () => aggregate
      );
    });

    return {
      dryRun,
      scanned: aggregate.scanned,
      wouldCopy: aggregate.wouldCopy,
      wouldSkip: aggregate.wouldSkip,
      failed: aggregate.failed,
      totalBytes: aggregate.totalBytes,
      batchCount,
      batchSize: BATCH_SIZE,
      planCount: aggregate.plan.length,
    };
  }
);
