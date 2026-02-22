import { $ } from "bun";
import { execSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { NonRetriableError } from "inngest";
import { inngest } from "../client";
import { emitMeasuredOtelEvent } from "../../observability/emit";

const HOME_DIR = process.env.HOME ?? "/Users/joel";

const NAS_NVME_ROOT = "/Volumes/nas-nvme"; // fast shared storage (1.78TB NVMe)
const NAS_HDD_ROOT = "/Volumes/three-body"; // bulk archive (57TB HDD RAID5)

const TYPESENSE_URL = process.env.TYPESENSE_URL ?? "http://localhost:8108";
const TYPESENSE_POD = "typesense-0";
const TYPESENSE_NAMESPACE = "joelclaw";
const TYPESENSE_SNAPSHOT_ROOT = "/data/snapshots";
const TYPESENSE_BACKUP_ROOT = `${NAS_HDD_ROOT}/backups/typesense`;
const TYPESENSE_STAGE_ROOT = "/tmp/joelclaw/typesense-snapshots";

const REDIS_POD = "redis-0";
const REDIS_NAMESPACE = "joelclaw";
const REDIS_BACKUP_ROOT = `${NAS_HDD_ROOT}/backups/redis`;

const SESSIONS_BACKUP_ROOT = `${NAS_HDD_ROOT}/sessions`;
const CLAUDE_PROJECTS_ROOT = `${HOME_DIR}/.claude/projects`;
const PI_SESSIONS_ROOT = `${HOME_DIR}/.pi/sessions`;

const OTEL_COLLECTION = "otel_events";
const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const OTEL_EXPORT_ROOT = `${NAS_HDD_ROOT}/otel`;

const MEMORY_LOG_ROOT = `${HOME_DIR}/.joelclaw/workspace/memory`;
const MEMORY_LOG_BACKUP_ROOT = `${NAS_HDD_ROOT}/backups/logs`;
const SLOG_PATH = `${HOME_DIR}/Vault/system/system-log.jsonl`;
const SLOG_BACKUP_ROOT = `${NAS_HDD_ROOT}/backups/slog`;

type ShellResult = {
  exitCode: number;
  stdout: Buffer | Uint8Array | string;
  stderr: Buffer | Uint8Array | string;
};

type TypesenseHit = {
  document?: Record<string, unknown>;
};

type TypesenseSearchResult = {
  hits?: TypesenseHit[];
};

function toText(value: Buffer | Uint8Array | string): string {
  if (typeof value === "string") return value.trim();
  return Buffer.from(value).toString("utf8").trim();
}

function commandError(command: string, result: ShellResult): Error {
  const stderr = toText(result.stderr);
  const stdout = toText(result.stdout);
  return new Error(
    `${command} failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`
  );
}

async function runShell(command: string, run: Promise<ShellResult>): Promise<ShellResult> {
  const result = await run;
  if (result.exitCode !== 0) throw commandError(command, result);
  return result;
}

function formatLosAngelesParts(now = new Date()): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const getPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";

  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
  };
}

function getDateStamp(now = new Date()): string {
  const parts = formatLosAngelesParts(now);
  return `${parts.year}${parts.month}${parts.day}`;
}

function getMonthStamp(now = new Date()): string {
  const parts = formatLosAngelesParts(now);
  return `${parts.year}${parts.month}`;
}

function getTypesenseApiKey(): string {
  if (process.env.TYPESENSE_API_KEY && process.env.TYPESENSE_API_KEY.trim().length > 0) {
    return process.env.TYPESENSE_API_KEY.trim();
  }

  try {
    return execSync("secrets lease typesense_api_key --ttl 5m", {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("No TYPESENSE_API_KEY and secrets lease failed");
  }
}

async function ensureNasMounted(): Promise<void> {
  const result = await $`stat ${NAS_HDD_ROOT}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const stderr = toText(result.stderr);
    throw new NonRetriableError(
      `NAS mount unavailable at ${NAS_HDD_ROOT}${stderr ? `: ${stderr}` : ""}`
    );
  }
}

async function ensureDir(path: string): Promise<void> {
  await runShell(
    `mkdir -p ${path}`,
    $`mkdir -p ${path}`.quiet().nothrow()
  );
}

async function pathExists(path: string): Promise<boolean> {
  const result = await $`stat ${path}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function listFilesOlderThanDays(
  root: string,
  olderThanDays: number,
  glob?: string
): Promise<string[]> {
  if (!(await pathExists(root))) return [];

  const result = glob
    ? await runShell(
      `find ${root} -type f -name ${glob} -mtime +${olderThanDays} -print`,
      $`find ${root} -type f -name ${glob} -mtime +${olderThanDays} -print`.quiet().nothrow()
    )
    : await runShell(
      `find ${root} -type f -mtime +${olderThanDays} -print`,
      $`find ${root} -type f -mtime +${olderThanDays} -print`.quiet().nothrow()
    );

  const stdout = toText(result.stdout);
  if (!stdout) return [];
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function destinationFromSourceRoot(filePath: string, sourceRoot: string, destinationRoot: string): string {
  const sourceRelative = relative(sourceRoot, filePath);
  if (!sourceRelative || sourceRelative.startsWith("..")) {
    return join(destinationRoot, basename(filePath));
  }
  return join(destinationRoot, sourceRelative);
}

function destinationFromHome(filePath: string, destinationRoot: string): string {
  const sourceRelative = relative(HOME_DIR, filePath);
  if (!sourceRelative || sourceRelative.startsWith("..")) {
    return join(destinationRoot, basename(filePath));
  }
  return join(destinationRoot, sourceRelative);
}

async function moveFile(sourcePath: string, targetPath: string): Promise<void> {
  await ensureDir(dirname(targetPath));
  await runShell(
    `mv ${sourcePath} ${targetPath}`,
    $`mv ${sourcePath} ${targetPath}`.quiet().nothrow()
  );
}

async function triggerTypesenseSnapshot(snapshotPath: string): Promise<unknown> {
  const apiKey = getTypesenseApiKey();
  const response = await fetch(
    `${TYPESENSE_URL}/operations/snapshot?snapshot_path=${encodeURIComponent(snapshotPath)}`,
    {
      method: "POST",
      headers: {
        "X-TYPESENSE-API-KEY": apiKey,
      },
      signal: AbortSignal.timeout(30_000),
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Typesense snapshot failed (${response.status}): ${responseText}`);
  }

  if (!responseText) return {};
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return { raw: responseText };
  }
}

async function fetchOtelPage(
  cutoffTimestamp: number,
  page: number,
  perPage: number
): Promise<Record<string, unknown>[]> {
  const apiKey = getTypesenseApiKey();
  const params = new URLSearchParams({
    q: "*",
    query_by: OTEL_QUERY_BY,
    per_page: String(perPage),
    page: String(page),
    sort_by: "timestamp:asc",
    filter_by: `timestamp:<${Math.floor(cutoffTimestamp)}`,
  });

  const response = await fetch(
    `${TYPESENSE_URL}/collections/${OTEL_COLLECTION}/documents/search?${params.toString()}`,
    {
      headers: {
        "X-TYPESENSE-API-KEY": apiKey,
      },
      signal: AbortSignal.timeout(30_000),
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Typesense otel search failed (${response.status}): ${responseText}`);
  }

  let parsed: TypesenseSearchResult = {};
  if (responseText) {
    parsed = JSON.parse(responseText) as TypesenseSearchResult;
  }
  const hits = Array.isArray(parsed.hits) ? parsed.hits : [];
  return hits
    .map((hit) => hit.document)
    .filter((doc): doc is Record<string, unknown> => !!doc && typeof doc === "object");
}

async function exportOtelEvents(cutoffTimestamp: number, outputPath: string): Promise<number> {
  const perPage = 250;
  let page = 1;
  let count = 0;

  const writer = createWriteStream(outputPath, { flags: "w" });
  try {
    while (true) {
      const documents = await fetchOtelPage(cutoffTimestamp, page, perPage);
      if (documents.length === 0) break;

      for (const document of documents) {
        writer.write(`${JSON.stringify(document)}\n`);
        count += 1;
      }

      if (documents.length < perPage) break;
      page += 1;
    }
  } finally {
    writer.end();
    await once(writer, "finish");
  }

  return count;
}

async function deleteOtelEvents(cutoffTimestamp: number): Promise<number> {
  const apiKey = getTypesenseApiKey();
  const filterBy = `timestamp:<${Math.floor(cutoffTimestamp)}`;
  const response = await fetch(
    `${TYPESENSE_URL}/collections/${OTEL_COLLECTION}/documents?batch_size=500&filter_by=${encodeURIComponent(filterBy)}`,
    {
      method: "DELETE",
      headers: {
        "X-TYPESENSE-API-KEY": apiKey,
      },
      signal: AbortSignal.timeout(30_000),
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Typesense otel delete failed (${response.status}): ${responseText}`);
  }

  if (!responseText) return 0;
  try {
    const parsed = JSON.parse(responseText) as { num_deleted?: number };
    return typeof parsed.num_deleted === "number" ? parsed.num_deleted : 0;
  } catch {
    return 0;
  }
}

export const backupTypesense = inngest.createFunction(
  {
    id: "system/backup.typesense",
    name: "Backup Typesense Snapshot to NAS",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: "TZ=America/Los_Angeles 0 3 * * *" }],
  async ({ step }) => {
    const metadata: Record<string, unknown> = {
      schedule: "daily_3am_pt",
      mount: NAS_HDD_ROOT,
    };

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "nas-backup",
        action: "system.backup.typesense",
        metadata,
      },
      async () => {
        await step.run("check-nas-mount", ensureNasMounted);

        const dateStamp = await step.run("resolve-date-stamp", async () => getDateStamp());
        const snapshotPath = `${TYPESENSE_SNAPSHOT_ROOT}/${dateStamp}`;
        const stagedSnapshotPath = `${TYPESENSE_STAGE_ROOT}/${dateStamp}`;
        const destinationPath = `${TYPESENSE_BACKUP_ROOT}/${dateStamp}`;

        await step.run("prepare-directories", async () => {
          await ensureDir(TYPESENSE_BACKUP_ROOT);
          await ensureDir(TYPESENSE_STAGE_ROOT);
          await runShell(
            `rm -rf ${stagedSnapshotPath} ${destinationPath}`,
            $`rm -rf ${stagedSnapshotPath} ${destinationPath}`.quiet().nothrow()
          );
          await ensureDir(destinationPath);
        });

        const snapshotResult = await step.run("trigger-snapshot", async () =>
          triggerTypesenseSnapshot(snapshotPath)
        );

        await step.run("copy-snapshot-to-host", async () => {
          // kubectl cp strips the source directory name when copying into an existing local dir.
          // Copy snapshot contents into an explicit dated staging directory so rsync has a stable source path.
          await ensureDir(stagedSnapshotPath);
          await runShell(
            `kubectl cp -n ${TYPESENSE_NAMESPACE} ${TYPESENSE_POD}:${snapshotPath}/. ${stagedSnapshotPath}`,
            $`kubectl cp -n ${TYPESENSE_NAMESPACE} ${TYPESENSE_POD}:${snapshotPath}/. ${stagedSnapshotPath}`.quiet().nothrow()
          );

          const snapshotContentProbe = await runShell(
            `find ${stagedSnapshotPath} -mindepth 1 -print -quit`,
            $`find ${stagedSnapshotPath} -mindepth 1 -print -quit`.quiet().nothrow()
          );
          if (!toText(snapshotContentProbe.stdout)) {
            throw new Error(`No Typesense snapshot files staged at ${stagedSnapshotPath}`);
          }
        });

        await step.run("sync-snapshot-to-nas", async () => {
          await runShell(
            `rsync -az ${stagedSnapshotPath}/ ${destinationPath}/`,
            $`rsync -az ${stagedSnapshotPath}/ ${destinationPath}/`.quiet().nothrow()
          );
        });

        await step.run("cleanup-stage", async () => {
          await runShell(
            `rm -rf ${stagedSnapshotPath}`,
            $`rm -rf ${stagedSnapshotPath}`.quiet().nothrow()
          );
        });

        metadata.date = dateStamp;
        metadata.snapshotPath = snapshotPath;
        metadata.destinationPath = destinationPath;
        metadata.snapshotResult = snapshotResult;

        return {
          date: dateStamp,
          snapshotPath,
          destinationPath,
        };
      }
    );
  }
);

export const backupRedis = inngest.createFunction(
  {
    id: "system/backup.redis",
    name: "Backup Redis RDB to NAS",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: "TZ=America/Los_Angeles 30 3 * * *" }],
  async ({ step }) => {
    const metadata: Record<string, unknown> = {
      schedule: "daily_330am_pt",
      mount: NAS_HDD_ROOT,
    };

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "nas-backup",
        action: "system.backup.redis",
        metadata,
      },
      async () => {
        await step.run("check-nas-mount", ensureNasMounted);

        const dateStamp = await step.run("resolve-date-stamp", async () => getDateStamp());
        const destinationPath = `${REDIS_BACKUP_ROOT}/dump-${dateStamp}.rdb`;

        await step.run("prepare-redis-backup-dir", async () => {
          await ensureDir(REDIS_BACKUP_ROOT);
        });

        await step.run("trigger-redis-bgsave", async () => {
          await runShell(
            `kubectl exec -n ${REDIS_NAMESPACE} ${REDIS_POD} -- redis-cli BGSAVE`,
            $`kubectl exec -n ${REDIS_NAMESPACE} ${REDIS_POD} -- redis-cli BGSAVE`.quiet().nothrow()
          );
        });

        await step.run("wait-for-bgsave", async () => {
          await Bun.sleep(10_000);
        });

        await step.run("copy-redis-rdb", async () => {
          await runShell(
            `kubectl cp -n ${REDIS_NAMESPACE} ${REDIS_POD}:/data/dump.rdb ${destinationPath}`,
            $`kubectl cp -n ${REDIS_NAMESPACE} ${REDIS_POD}:/data/dump.rdb ${destinationPath}`.quiet().nothrow()
          );
        });

        metadata.date = dateStamp;
        metadata.destinationPath = destinationPath;

        return {
          date: dateStamp,
          destinationPath,
        };
      }
    );
  }
);

export const rotateSessions = inngest.createFunction(
  {
    id: "system/rotate.sessions",
    name: "Rotate Old Session Files to NAS",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: "TZ=America/Los_Angeles 0 4 * * 0" }],
  async ({ step }) => {
    const metadata: Record<string, unknown> = {
      schedule: "weekly_sunday_4am_pt",
      mount: NAS_HDD_ROOT,
    };

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "nas-rotate",
        action: "system.rotate.sessions",
        metadata,
      },
      async () => {
        await step.run("check-nas-mount", ensureNasMounted);

        await step.run("prepare-sessions-dir", async () => {
          await ensureDir(SESSIONS_BACKUP_ROOT);
        });

        const claudeFiles = await step.run("list-claude-sessions", async () =>
          listFilesOlderThanDays(CLAUDE_PROJECTS_ROOT, 7, "*.jsonl")
        );
        const piFiles = await step.run("list-pi-sessions", async () =>
          listFilesOlderThanDays(PI_SESSIONS_ROOT, 7)
        );

        const filesToMove = [...claudeFiles, ...piFiles];

        const movedCount = await step.run("move-session-files", async () => {
          let moved = 0;
          for (const filePath of filesToMove) {
            const destinationPath = destinationFromHome(filePath, SESSIONS_BACKUP_ROOT);
            await moveFile(filePath, destinationPath);
            moved += 1;
          }
          return moved;
        });

        metadata.filesExamined = filesToMove.length;
        metadata.rotatedCount = movedCount;
        metadata.claudeCount = claudeFiles.length;
        metadata.piCount = piFiles.length;

        return {
          rotatedCount: movedCount,
          claudeCount: claudeFiles.length,
          piCount: piFiles.length,
        };
      }
    );
  }
);

export const rotateOtel = inngest.createFunction(
  {
    id: "system/rotate.otel",
    name: "Rotate OTEL Events to NAS Archive",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: "TZ=America/Los_Angeles 0 4 1 * *" }],
  async ({ step }) => {
    const metadata: Record<string, unknown> = {
      schedule: "monthly_1st_4am_pt",
      mount: NAS_HDD_ROOT,
      retentionDays: 90,
    };

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "nas-rotate",
        action: "system.rotate.otel",
        metadata,
      },
      async () => {
        await step.run("check-nas-mount", ensureNasMounted);

        const monthStamp = await step.run("resolve-month-stamp", async () => getMonthStamp());
        const outputPath = `${OTEL_EXPORT_ROOT}/otel-${monthStamp}.jsonl`;
        const cutoffTimestamp = Date.now() - (90 * 24 * 60 * 60 * 1000);

        await step.run("prepare-otel-dir", async () => {
          await ensureDir(OTEL_EXPORT_ROOT);
        });

        const exportedCount = await step.run("export-otel-events", async () =>
          exportOtelEvents(cutoffTimestamp, outputPath)
        );

        const deletedCount = await step.run("delete-exported-otel-events", async () => {
          if (exportedCount === 0) return 0;
          return deleteOtelEvents(cutoffTimestamp);
        });

        metadata.month = monthStamp;
        metadata.outputPath = outputPath;
        metadata.cutoffTimestamp = cutoffTimestamp;
        metadata.exportedCount = exportedCount;
        metadata.deletedCount = deletedCount;

        return {
          month: monthStamp,
          outputPath,
          exportedCount,
          deletedCount,
        };
      }
    );
  }
);

export const rotateLogs = inngest.createFunction(
  {
    id: "system/rotate.logs",
    name: "Rotate Local Logs to NAS",
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: "TZ=America/Los_Angeles 30 4 1 * *" }],
  async ({ step }) => {
    const metadata: Record<string, unknown> = {
      schedule: "monthly_1st_430am_pt",
      mount: NAS_HDD_ROOT,
      retentionDays: 30,
    };

    return emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "nas-rotate",
        action: "system.rotate.logs",
        metadata,
      },
      async () => {
        await step.run("check-nas-mount", ensureNasMounted);

        const monthStamp = await step.run("resolve-month-stamp", async () => getMonthStamp());
        const slogDestinationPath = `${SLOG_BACKUP_ROOT}/system-log-${monthStamp}.jsonl`;

        await step.run("prepare-log-dirs", async () => {
          await ensureDir(MEMORY_LOG_BACKUP_ROOT);
          await ensureDir(SLOG_BACKUP_ROOT);
        });

        const oldLogFiles = await step.run("list-old-memory-logs", async () =>
          listFilesOlderThanDays(MEMORY_LOG_ROOT, 30)
        );

        const movedLogs = await step.run("move-old-memory-logs", async () => {
          let moved = 0;
          for (const filePath of oldLogFiles) {
            const destinationPath = destinationFromSourceRoot(filePath, MEMORY_LOG_ROOT, MEMORY_LOG_BACKUP_ROOT);
            await moveFile(filePath, destinationPath);
            moved += 1;
          }
          return moved;
        });

        await step.run("copy-current-slog", async () => {
          await runShell(
            `cp ${SLOG_PATH} ${slogDestinationPath}`,
            $`cp ${SLOG_PATH} ${slogDestinationPath}`.quiet().nothrow()
          );
        });

        metadata.month = monthStamp;
        metadata.movedLogs = movedLogs;
        metadata.slogDestinationPath = slogDestinationPath;

        return {
          month: monthStamp,
          movedLogs,
          slogDestinationPath,
        };
      }
    );
  }
);
