#!/usr/bin/env bun

import Redis from "ioredis";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const INNGEST_VERSION = "1.27.0";
const INNGEST_COMMIT = "781c91d3c5c21852e84ee575d6d36b1ad9dcde1a";
const INNGEST_BINARY = "/Users/Shared/joelclaw/opt/inngest/1.27.0/inngest";
const DEQUEUE_LUA = resolve(import.meta.dir, "vendor/inngest-v1.27.0/queue-dequeue.lua");
const REDIS_URL = "redis://127.0.0.1:6379";
const QUEUE_ITEM_KEY = "{queue}:queue:item";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const EXPECTED_COUNT = 595;
// --accept-scan (Joel, 2026-07-20): bounces mint new envID-less items, so an
// exact pre-pinned count drifts by apply time. Window-scoped authorization
// keeps the criteria fence (five prefixes + missing envID) and replaces the
// exact count with a hard ceiling; anything above it means the criteria are
// selecting more than the known poison population — stop and re-review.
const ACCEPT_SCAN_CEILING = 650;
const TARGET_FUNCTION_PREFIXES = [
  "155f899f",
  "8f5e3d9e",
  "ce6c53eb",
  "6d5d880e",
  "6489b63e",
] as const;

type QueueItem = {
  id: string;
  at: number;
  wt: number;
  wfID: string;
  wsID?: string;
  ip?: number;
  queueID?: string;
  data: {
    kind: string;
    qn?: string;
    identifier: {
      runID: string;
      wID?: string;
      wsID?: string;
      aID: string;
      cck?: Array<{ k: string; h: string; l: number }>;
    };
    cck?: Array<{ k: string; h: string; l: number }>;
    throttle?: { k: string; keh?: string };
  };
};

type ManifestItem = {
  jobID: string;
  functionID: string;
  functionPrefix: string;
  runID: string;
  kind: string;
  atMS: number;
  envID: string | null;
  backlogKey: string;
};

type Manifest = {
  tool: "inngest-v127-purge";
  mode: "dry-run" | "apply";
  generatedAt: string;
  inngest: {
    expectedVersion: string;
    installedVersion: string;
    sourceCommit: string;
    binary: string;
    dequeueLua: string;
  };
  redis: { url: string; lastSave: number; queueItemCount: number };
  selection: {
    expectedCount: number;
    actualCount: number;
    authorizationConditionMet: boolean;
    targetFunctionPrefixes: readonly string[];
    countsByFunctionID: Record<string, number>;
  };
  items: ManifestItem[];
};

function usage(): never {
  console.error(
    "Usage: bun scripts/inngest-v127-purge.ts --dry-run --manifest <path.svx>\n" +
      "       bun scripts/inngest-v127-purge.ts --apply --manifest <path.svx>",
  );
  process.exit(2);
}

function parseArgs(): {
  mode: "dry-run" | "apply";
  manifestPath: string;
  acceptScan: boolean;
} {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (dryRun === apply) usage();

  const manifestIndex = process.argv.indexOf("--manifest");
  const manifestPath = process.argv[manifestIndex + 1];
  if (manifestIndex < 0 || !manifestPath) usage();

  return {
    mode: apply ? "apply" : "dry-run",
    manifestPath: resolve(manifestPath),
    acceptScan: process.argv.includes("--accept-scan"),
  };
}

function installedVersion(): string {
  const result = Bun.spawnSync([INNGEST_BINARY, "version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    throw new Error(`Could not verify ${INNGEST_BINARY}: ${stderr || stdout}`);
  }
  if (!stdout.startsWith(`${INNGEST_VERSION}-`)) {
    throw new Error(
      `Installed Inngest version mismatch: expected ${INNGEST_VERSION}, got ${stdout}`,
    );
  }
  return stdout;
}

function targetPrefix(functionID: string): string | null {
  return TARGET_FUNCTION_PREFIXES.find((prefix) => functionID.startsWith(prefix)) ?? null;
}

function envID(item: QueueItem): string | null {
  return item.data.identifier.wsID ?? item.wsID ?? null;
}

function isMissingEnvID(item: QueueItem): boolean {
  const value = envID(item);
  return value === null || value === "" || value === ZERO_UUID;
}

async function loadQueueItems(redis: Redis): Promise<Array<{ item: QueueItem; prefix: string }>> {
  const selected: Array<{ item: QueueItem; prefix: string }> = [];
  let cursor = "0";

  do {
    const [nextCursor, entries] = await redis.hscan(QUEUE_ITEM_KEY, cursor, "COUNT", 500);
    cursor = nextCursor;
    for (let index = 0; index < entries.length; index += 2) {
      const field = entries[index];
      const raw = entries[index + 1];
      if (!field || !raw) continue;

      const item = JSON.parse(raw) as QueueItem;
      if (item.id !== field) {
        throw new Error(`Queue item field/id mismatch: ${field} != ${item.id}`);
      }
      const prefix = targetPrefix(item.wfID);
      if (prefix && isMissingEnvID(item)) selected.push({ item, prefix });
    }
  } while (cursor !== "0");

  selected.sort((left, right) => left.item.id.localeCompare(right.item.id));
  return selected;
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys.sort();
}

async function resolveBacklogKeys(
  redis: Redis,
  selected: Array<{ item: QueueItem; prefix: string }>,
): Promise<Map<string, string>> {
  const candidatesByFunction = new Map<string, string[]>();
  for (const { item } of selected) {
    if (candidatesByFunction.has(item.wfID)) continue;
    candidatesByFunction.set(
      item.wfID,
      await scanKeys(redis, `{queue}:backlog:sorted:fn:${item.wfID}*`),
    );
  }

  const resolved = new Map<string, string>();
  for (const { item } of selected) {
    const candidates = candidatesByFunction.get(item.wfID) ?? [];
    const pipeline = redis.pipeline();
    for (const key of candidates) pipeline.zscore(key, item.id);
    const results = candidates.length > 0 ? await pipeline.exec() : [];
    const matches = candidates.filter((_, index) => results?.[index]?.[1] !== null);
    if (matches.length > 1) {
      throw new Error(
        `Queue item ${item.id} exists in multiple backlog sets: ${matches.join(", ")}`,
      );
    }
    resolved.set(item.id, matches[0] ?? `{queue}:backlog:sorted:fn:${item.wfID}`);
  }
  return resolved;
}

function itemIndexes(item: QueueItem): [string, string] {
  const runIndex = `{queue}:idx:run:${item.data.identifier.runID}`;
  switch (item.data.kind) {
    case "start":
      return [runIndex, `{queue}:queue:status:${item.wfID}:start`];
    case "edge":
    case "edge-error":
      return [runIndex, `{queue}:queue:status:${item.wfID}:in-progress`];
    case "sleep":
      return [runIndex, `{queue}:queue:status:${item.wfID}:sleep`];
    case "pause":
      return [runIndex, ""];
    default:
      return ["", ""];
  }
}

function dequeueKeys(item: QueueItem, backlogKey: string): string[] {
  const queueName = item.queueID ?? item.data.qn;
  const partitionID = queueName || item.wfID;
  const accountID = item.data.identifier.aID;
  const [indexA, indexB] = itemIndexes(item);
  return [
    QUEUE_ITEM_KEY,
    "{queue}:partition:item",
    "{queue}:concurrency:sorted",
    `{queue}:queue:sorted:${partitionID}`,
    "{queue}:partition:sorted",
    "{queue}:accounts:sorted",
    `{queue}:accounts:${accountID}:partition:sorted`,
    "{queue}:shadows",
    "{queue}:backlogs",
    backlogKey,
    `{queue}:shadow:sorted:${partitionID}`,
    "{queue}:shadow:sorted",
    "{queue}:accounts:shadows:sorted",
    accountID === ZERO_UUID
      ? "{queue}:accounts:shadows:sorted:-"
      : `{queue}:accounts:${accountID}:shadows:sorted`,
    `{queue}:normalize:partition:${partitionID}:sorted`,
    `{queue}:queue:seen:${item.id}`,
    `{queue}:singleton-run:${item.data.identifier.runID}`,
    `{queue}:scavenger:${partitionID}:sorted`,
    indexA,
    indexB,
  ];
}

function dequeueArgs(item: QueueItem, backlogKey: string): string[] {
  const queueName = item.queueID ?? item.data.qn;
  const partitionID = queueName || item.wfID;
  const backlogID = backlogKey.replace("{queue}:backlog:sorted:", "");
  const idempotencySeconds = item.ip === undefined ? 12 * 60 * 60 : Math.floor(item.ip / 1e9);
  return [
    item.id,
    partitionID,
    backlogID,
    item.data.identifier.aID,
    item.data.identifier.runID,
    String(idempotencySeconds),
  ];
}

function manifestItems(
  selected: Array<{ item: QueueItem; prefix: string }>,
  backlogKeys: Map<string, string>,
): ManifestItem[] {
  return selected.map(({ item, prefix }) => ({
    jobID: item.id,
    functionID: item.wfID,
    functionPrefix: prefix,
    runID: item.data.identifier.runID,
    kind: item.data.kind,
    atMS: item.at,
    envID: envID(item),
    backlogKey: backlogKeys.get(item.id) ?? "",
  }));
}

function countsByFunctionID(items: ManifestItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.functionID] = (counts[item.functionID] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function authorizationConditionMet(
  items: ManifestItem[],
  counts: Record<string, number>,
  acceptScan: boolean,
): boolean {
  const countOk = acceptScan
    ? items.length > 0 && items.length <= ACCEPT_SCAN_CEILING
    : items.length === EXPECTED_COUNT;
  if (!countOk || Object.keys(counts).length > TARGET_FUNCTION_PREFIXES.length) {
    return false;
  }
  return Object.keys(counts).every((functionID) =>
    TARGET_FUNCTION_PREFIXES.some((prefix) => functionID.startsWith(prefix)),
  );
}

function renderAsset(manifest: Manifest): string {
  const counts = Object.entries(manifest.selection.countsByFunctionID)
    .map(([functionID, count]) => `| \`${functionID}\` | ${count} |`)
    .join("\n");
  return `---
title: "Inngest v1.27.0 queue purge ${manifest.mode} manifest"
type: "asset"
parent: "./build-and-run-queue-purge.svx"
date: "${manifest.generatedAt.slice(0, 10)}"
---

# Inngest v1.27.0 queue purge ${manifest.mode} manifest

- Mode: \`${manifest.mode}\`
- Installed binary: \`${manifest.inngest.installedVersion}\`
- Pinned source: \`inngest/inngest@v${manifest.inngest.expectedVersion}\` / \`${manifest.inngest.sourceCommit}\`
- Redis: \`${manifest.redis.url}\`
- Redis \`LASTSAVE\`: \`${manifest.redis.lastSave}\`
- Queue items scanned: **${manifest.redis.queueItemCount}**
- Selected items: **${manifest.selection.actualCount}**
- Expected items: **${manifest.selection.expectedCount}**
- Authorization condition met: **${manifest.selection.authorizationConditionMet ? "yes" : "no"}**

## Counts by function

| Function ID | Items |
| --- | ---: |
${counts}

## Manifest

\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`
`;
}

async function main(): Promise<void> {
  const { mode, manifestPath, acceptScan } = parseArgs();
  const version = installedVersion();
  const dequeueLua = await readFile(DEQUEUE_LUA, "utf8");
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  try {
    await redis.connect();
    const [lastSave, queueItemCount, selected] = await Promise.all([
      redis.lastsave(),
      redis.hlen(QUEUE_ITEM_KEY),
      loadQueueItems(redis),
    ]);
    const backlogKeys = await resolveBacklogKeys(redis, selected);
    const items = manifestItems(selected, backlogKeys);
    const counts = countsByFunctionID(items);
    const authorized = authorizationConditionMet(items, counts, acceptScan);

    const manifest: Manifest = {
      tool: "inngest-v127-purge",
      mode,
      generatedAt: new Date().toISOString(),
      inngest: {
        expectedVersion: INNGEST_VERSION,
        installedVersion: version,
        sourceCommit: INNGEST_COMMIT,
        binary: INNGEST_BINARY,
        dequeueLua: DEQUEUE_LUA,
      },
      redis: { url: REDIS_URL, lastSave, queueItemCount },
      selection: {
        expectedCount: EXPECTED_COUNT,
        actualCount: items.length,
        authorizationConditionMet: authorized,
        targetFunctionPrefixes: TARGET_FUNCTION_PREFIXES,
        countsByFunctionID: counts,
      },
      items,
    };

    await writeFile(manifestPath, renderAsset(manifest), "utf8");

    console.log(`Mode: ${mode}`);
    console.log(`Installed Inngest: ${version}`);
    console.log(`Redis LASTSAVE: ${lastSave}`);
    console.log(`Queue items scanned: ${queueItemCount}`);
    console.log(`Selected items: ${items.length}`);
    for (const [functionID, count] of Object.entries(counts)) {
      console.log(`- ${functionID}: ${count}`);
    }
    console.log(`Authorization condition met: ${authorized ? "yes" : "no"}`);
    console.log(`Manifest: ${manifestPath}`);

    if (!authorized) {
      throw new Error(
        acceptScan
          ? `Selection out of fence: ${items.length} items (ceiling ${ACCEPT_SCAN_CEILING}) or a non-target function was selected`
          : `Selection mismatch: expected exactly ${EXPECTED_COUNT} items across all five target function IDs`,
      );
    }

    if (mode === "apply") {
      let applied = 0;
      for (const { item } of selected) {
        const backlogKey = backlogKeys.get(item.id);
        if (!backlogKey) throw new Error(`Missing resolved backlog key for ${item.id}`);
        const result = await redis.eval(
          dequeueLua,
          20,
          ...dequeueKeys(item, backlogKey),
          ...dequeueArgs(item, backlogKey),
        );
        if (result !== 0) throw new Error(`DequeueByJobID(${item.id}) returned ${String(result)}`);
        applied += 1;
      }
      console.log(`Applied DequeueByJobID: ${applied}`);
    }
  } finally {
    redis.disconnect();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
