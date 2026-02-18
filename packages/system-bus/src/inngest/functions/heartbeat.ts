import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import { auditTriggers } from "./trigger-audit";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function getHomeDirectory(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

async function collectFilesRecursively(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;

  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursively(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function pruneOldFiles(paths: string[], olderThanMs: number): Promise<number> {
  const threshold = Date.now() - olderThanMs;
  let prunedCount = 0;

  for (const path of paths) {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(path);
    } catch {
      continue;
    }

    if (fileStat.mtimeMs >= threshold) {
      continue;
    }

    try {
      await rm(path, { force: true });
      prunedCount += 1;
    } catch {
      // Ignore best-effort cleanup failures.
    }
  }

  return prunedCount;
}

async function pruneOldSessionFiles() {
  const home = getHomeDirectory();
  const sessionsDir = join(home, ".pi", "agent", "sessions");
  const claudeDebugDir = join(home, ".claude", "debug");

  const sessionFiles = await collectFilesRecursively(sessionsDir);
  const oldSessionJsonlPaths = sessionFiles.filter((filePath) => filePath.endsWith(".jsonl"));
  const debugFiles = await collectFilesRecursively(claudeDebugDir);

  const prunedSessionsCount = await pruneOldFiles(oldSessionJsonlPaths, THIRTY_DAYS_MS);
  const prunedDebugCount = await pruneOldFiles(debugFiles, THIRTY_DAYS_MS);
  const prunedCount = prunedSessionsCount + prunedDebugCount;

  console.log("[heartbeat] prune-old-sessions", {
    prunedCount,
    prunedSessionsCount,
    prunedDebugCount,
  });

  return { prunedCount, prunedSessionsCount, prunedDebugCount };
}

export const heartbeatCron = inngest.createFunction(
  {
    id: "system-heartbeat",
  },
  [{ cron: "*/15 * * * *" }],
  async ({ step }) => {
    await step.run("prune-old-sessions", pruneOldSessionFiles);

    const triggerAudit = await step.run("audit-triggers", async () => {
      try {
        return await auditTriggers();
      } catch (err) {
        return { ok: true, checked: 0, drifted: [], missing: [], extra: [], error: String(err) };
      }
    });

    await step.run("push-gateway-event", async () => {
      const payload: Record<string, unknown> = {};

      // Alert on trigger drift — silent misregistration is how the promote
      // bug went undetected. See ADR-0021 Phase 3 postmortem.
      if (!triggerAudit.ok) {
        payload.triggerDrift = {
          drifted: triggerAudit.drifted,
          missing: triggerAudit.missing,
        };
      }

      await pushGatewayEvent({
        type: triggerAudit.ok ? "cron.heartbeat" : "cron.heartbeat.drift",
        source: "inngest",
        payload,
      });
    });
  }
);

export const heartbeatWake = inngest.createFunction(
  {
    id: "system-heartbeat-wake",
  },
  [{ event: "system/heartbeat.wake" }],
  async ({ step }) => {
    await step.run("prune-old-sessions", pruneOldSessionFiles);

    await step.run("push-gateway-event", async () => {
      await pushGatewayEvent({
        type: "cron.heartbeat",
        source: "inngest",
        payload: {},
      });
    });
  }
);
