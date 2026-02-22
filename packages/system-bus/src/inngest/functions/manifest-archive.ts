import { $ } from "bun";
import Redis from "ioredis";
import { NonRetriableError } from "inngest";
import { access, readFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { inngest } from "../client";
import { emitMeasuredOtelEvent } from "../../observability/emit";
import { pushGatewayEvent } from "./agent-loop/utils";

const DARK_WIZARD = "joel@100.86.171.79";
const CLANKER = "joel@100.95.167.75";
const THREE_BODY = "/Volumes/three-body";
const TMP_MANIFEST_PATH = "/tmp/manifest.clean.jsonl";
const DEFAULT_MANIFEST_PATH = `${process.env.HOME}/Documents/manifest.clean.jsonl`;
const REDIS_KEY = "manifest:archive:state";

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

type FileResult = {
  id: string;
  action: "copy" | "skip" | "would-copy" | "error";
  src?: string;
  dest?: string;
  bytes?: number;
  error?: string;
};

type BookCategory =
  | "programming"
  | "business"
  | "education"
  | "design"
  | "other"
  | "uncategorized";

const BOOK_CATEGORIES: BookCategory[] = [
  "programming",
  "business",
  "education",
  "design",
  "other",
  "uncategorized",
];

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest =
    process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    connectTimeout: 3_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Uint8Array)
    return Buffer.from(value).toString("utf8").trim();
  return String(value ?? "").trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBytes(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function normalizeMaxEntries(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
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
    base = base
      .slice(0, maxBaseLength)
      .replace(/^[-_.]+|[-_.]+$/g, "");
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

function isBookCategory(value: string): value is BookCategory {
  return BOOK_CATEGORIES.includes(value as BookCategory);
}

export function getDestPath(entry: ManifestEntry): string {
  const filename = sanitizeFilename(entry.filename);
  if (entry.sourcePath.includes("/clawd/podcasts/")) {
    return join(THREE_BODY, "podcasts", filename);
  }
  return join(
    THREE_BODY,
    "books",
    getCategoryDir(entry.enrichmentCategory),
    filename,
  );
}

function parseManifestEntry(
  raw: unknown,
  lineNumber: number,
): ManifestEntry {
  if (!raw || typeof raw !== "object") {
    throw new NonRetriableError(
      `Manifest entry at line ${lineNumber} is not an object`,
    );
  }

  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const filename =
    typeof value.filename === "string" ? value.filename.trim() : "";
  const sourcePath =
    typeof value.sourcePath === "string" ? value.sourcePath.trim() : "";

  if (!id || !filename || !sourcePath) {
    throw new NonRetriableError(
      `Manifest entry at line ${lineNumber} is missing required id/filename/sourcePath`,
    );
  }

  return {
    id,
    filename,
    sourcePath,
    sourceExists: Boolean(value.sourceExists),
    enrichmentCategory:
      typeof value.enrichmentCategory === "string"
        ? value.enrichmentCategory
        : null,
    enrichmentDocumentType:
      typeof value.enrichmentDocumentType === "string"
        ? value.enrichmentDocumentType
        : null,
    sourceFileType:
      typeof value.sourceFileType === "string" &&
      value.sourceFileType.trim().length > 0
        ? value.sourceFileType
        : "unknown",
    sourceSizeBytes: normalizeBytes(value.sourceSizeBytes),
  };
}

async function loadManifest(manifestPath: string): Promise<ManifestEntry[]> {
  try {
    await access(manifestPath);
  } catch {
    throw new NonRetriableError(
      `Manifest not found at ${manifestPath}`,
    );
  }

  let text = "";
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new NonRetriableError(
      `Manifest read failed at ${manifestPath}: ${formatError(error)}`,
    );
  }
  const entries: ManifestEntry[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new NonRetriableError(
        `Invalid JSON in manifest at line ${i + 1}: ${formatError(error)}`,
      );
    }

    entries.push(parseManifestEntry(parsed, i + 1));
  }

  return entries;
}

async function resolveManifestPath(requestedPath: unknown): Promise<string> {
  if (typeof requestedPath === "string" && requestedPath.trim().length > 0) {
    return requestedPath.trim();
  }

  const envPath = process.env.MANIFEST_ARCHIVE_MANIFEST_PATH?.trim();
  if (envPath) return envPath;

  try {
    await access(TMP_MANIFEST_PATH);
    return TMP_MANIFEST_PATH;
  } catch {
    return DEFAULT_MANIFEST_PATH;
  }
}

/**
 * Process a single file: check Redis, plan or copy, update state.
 * Each file is its own Inngest step → individual retry + memoization.
 */
async function processFile(
  entry: ManifestEntry,
  dryRun: boolean,
): Promise<FileResult> {
  const srcHost = entry.sourceExists ? DARK_WIZARD : CLANKER;
  const src = `${srcHost}:${entry.sourcePath}`;
  const dest = getDestPath(entry);
  const bytes = normalizeBytes(entry.sourceSizeBytes);

  if (dryRun) {
    return { id: entry.id, action: "would-copy", src, dest, bytes };
  }

  const redis = getRedis();

  // Already copied? Skip.
  const copiedState = await redis.hget(REDIS_KEY, entry.id);
  if (isCopiedState(copiedState)) {
    return { id: entry.id, action: "skip" };
  }

  // Live mode: mkdir + scp + mark copied
  const destDir = join(dest, "..");
  const mkdirResult = await $`mkdir -p ${destDir}`.quiet().nothrow();
  if (mkdirResult.exitCode !== 0) {
    return {
      id: entry.id,
      action: "error",
      error: `mkdir failed: ${toText(mkdirResult.stderr)}`,
    };
  }

  const scpResult =
    await $`scp -o BatchMode=yes -o ConnectTimeout=10 ${src} ${dest}`
      .quiet()
      .nothrow();
  if (scpResult.exitCode !== 0) {
    return {
      id: entry.id,
      action: "error",
      src,
      dest,
      error: `scp failed: ${toText(scpResult.stderr)}`,
    };
  }

  // Mark as copied in Redis
  await redis.hset(
    REDIS_KEY,
    entry.id,
    JSON.stringify({ status: "copied", ts: Date.now() }),
  );

  return { id: entry.id, action: "copy", src, dest, bytes };
}

export const manifestArchive = inngest.createFunction(
  {
    id: "manifest-archive",
    singleton: { key: '"global"', mode: "skip" },
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ event: "manifest/archive.requested" }],
  async ({ event, step }) => {
    const dryRun = event.data.dryRun ?? true;
    const eventData = event.data as {
      maxEntries?: unknown;
      manifestPath?: unknown;
      reason?: string;
    };
    const maxEntries = normalizeMaxEntries(eventData.maxEntries);
    const manifestPath = await resolveManifestPath(eventData.manifestPath);

    // Step 1: Validate prereqs (NAS mount + SSH connectivity)
    await step.run("validate-prereqs", async () => {
      await emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "manifest-archive",
          action: "manifest.archive.started",
          metadata: {
            dryRun,
            reason: eventData.reason ?? null,
            maxEntries,
            manifestPath,
          },
        },
        async () => ({ phase: "start" }),
      );
      const nasCheck = await $`ls ${THREE_BODY}`.quiet().nothrow();
      if (nasCheck.exitCode !== 0) {
        throw new NonRetriableError(
          `NAS mount not accessible at ${THREE_BODY}: ${toText(nasCheck.stderr || nasCheck.stdout)}`,
        );
      }

      for (const host of [DARK_WIZARD, CLANKER]) {
        const sshCheck =
          await $`ssh -o BatchMode=yes -o ConnectTimeout=5 ${host} echo ok`
            .quiet()
            .nothrow();
        if (sshCheck.exitCode !== 0) {
          throw new NonRetriableError(
            `SSH prereq failed for ${host}: ${toText(sshCheck.stderr || sshCheck.stdout)}`,
          );
        }
      }
    });

    await step.run("prereqs-passed", async () => {
      await emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "manifest-archive",
          action: "manifest.archive.prereqs-passed",
          metadata: { dryRun, maxEntries, manifestPath },
        },
        async () => ({ phase: "prereqs-done" }),
      );
    });

    const manifestEntries = await loadManifest(manifestPath);
    const entries = maxEntries
      ? manifestEntries.slice(0, Math.min(maxEntries, manifestEntries.length))
      : manifestEntries;

    // Steps 3..N: One step per file (806 files = 806 steps, under 1,000 limit)
    // Each step is independently retried and memoized.
    const results: FileResult[] = [];

    for (const entry of entries) {
      const result = await step.run(
        `file-${entry.id}`,
        async () => processFile(entry, dryRun),
      );
      results.push(result);
    }

    // Aggregate
    const copied = results.filter((r) => r.action === "copy");
    const wouldCopy = results.filter((r) => r.action === "would-copy");
    const skipped = results.filter((r) => r.action === "skip");
    const errors = results.filter((r) => r.action === "error");
    const planned = [...copied, ...wouldCopy];
    const totalBytes = planned.reduce((sum, r) => sum + (r.bytes ?? 0), 0);

    const booksRouting: Record<BookCategory, number> = {
      programming: 0,
      business: 0,
      education: 0,
      design: 0,
      other: 0,
      uncategorized: 0,
    };
    let podcasts = 0;

    for (const item of planned) {
      if (!item.dest) continue;
      if (item.dest.includes(`${THREE_BODY}/podcasts/`)) {
        podcasts += 1;
        continue;
      }
      const booksPrefix = `${THREE_BODY}/books/`;
      if (!item.dest.includes(booksPrefix)) continue;
      const route = item.dest.slice(item.dest.indexOf(booksPrefix) + booksPrefix.length);
      const category = route.split("/")[0] ?? "uncategorized";
      if (isBookCategory(category)) {
        booksRouting[category] = booksRouting[category] + 1;
      } else {
        booksRouting.uncategorized = booksRouting.uncategorized + 1;
      }
    }

    const summary = {
      dryRun,
      scanned: results.length,
      copied: copied.length,
      wouldCopy: wouldCopy.length,
      skipped: skipped.length,
      wouldSkip: skipped.length,
      failed: errors.length,
      totalBytes,
      routing: {
        podcasts,
        books: booksRouting,
      },
      maxEntries,
      manifestPath,
      errorDetails: errors.slice(0, 20).map((e) => ({
        id: e.id,
        error: e.error,
      })),
    };

    // Emit completion event (no giant plan array — just summary)
    await step.sendEvent("emit-complete", {
      name: "manifest/archive.completed",
      data: summary,
    });

    // Gateway notification
    await step.run("notify-gateway", async () => {
      try {
        const label = dryRun ? "dry-run" : "archive";
        await pushGatewayEvent({
          type: `manifest.archive.${label}.completed`,
          source: "inngest",
          payload: summary,
        });
      } catch (error) {
        console.error(
          `[manifest-archive] gateway event failed: ${formatError(error)}`,
        );
      }
    });

    // OTEL telemetry
    await step.run("emit-otel", async () => {
      const label = dryRun ? "dry-run" : "archive";
      await emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "manifest-archive",
          action: `manifest.archive.${label}.completed`,
          metadata: summary,
        },
        async () => summary,
      );
    });

    return summary;
  },
);
