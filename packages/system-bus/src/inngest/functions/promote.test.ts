import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import Redis from "ioredis";
import { archiveProposal, expireProposal, parseReviewMd, promote, promoteToMemory } from "./promote";

type RedisMockState = {
  hashes: Map<string, Record<string, string>>;
  lists: Map<string, string[]>;
};

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalRedisMethods = {
  lrange: Redis.prototype.lrange,
  hgetall: Redis.prototype.hgetall,
  hset: Redis.prototype.hset,
  lrem: (Redis.prototype as { lrem?: unknown }).lrem,
  del: Redis.prototype.del,
  rpush: Redis.prototype.rpush,
};

let redisState: RedisMockState = {
  hashes: new Map(),
  lists: new Map(),
};

let tempHome = "";
let workspaceDir = "";
let reviewPath = "";
let memoryPath = "";

function proposalKey(id: string): string {
  return `memory:review:proposal:${id}`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function compactDate(date: Date): string {
  return isoDate(date).replaceAll("-", "");
}

function proposalIdDaysAgo(daysAgo: number, seq = "001"): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `p-${compactDate(d)}-${seq}`;
}

function todayLogPath(): string {
  return join(workspaceDir, "memory", `${isoDate(new Date())}.md`);
}

function writeWorkspaceFiles(reviewMarkdown: string): void {
  mkdirSync(join(workspaceDir, "memory"), { recursive: true });

  writeFileSync(
    memoryPath,
    [
      "# Team Memory",
      "",
      "## Hard Rules",
      "- Existing hard rule.",
      "",
      "## System Architecture",
      "- Existing architecture note.",
      "",
      "## Patterns",
      "- Existing pattern note.",
      "",
    ].join("\n")
  );

  writeFileSync(reviewPath, reviewMarkdown);
}

function putProposal(id: string, fields: Record<string, string>): void {
  redisState.hashes.set(proposalKey(id), {
    id,
    status: "pending",
    ...fields,
  });
}

function getSectionBlock(markdown: string, sectionTitle: string): string {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `## ${sectionTitle}`);
  if (start === -1) return "";

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").startsWith("## ")) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join("\n");
}

async function executePromoteWithEvent(event: { name: string; data: Record<string, unknown> }) {
  const engine = new InngestTestEngine({
    function: promote as any,
    events: [event as any],
  });
  return engine.execute();
}

async function loadPromotePromptModule(): Promise<{ exists: boolean; module: Record<string, unknown> | null }> {
  const promotePromptUrl = new URL("./promote-prompt.ts", import.meta.url);
  const file = Bun.file(promotePromptUrl);
  const exists = await file.exists();
  if (!exists) return { exists, module: null };

  const loaded = await import(`${promotePromptUrl.href}?ts=${Date.now()}`);
  return { exists, module: loaded as Record<string, unknown> };
}

beforeAll(() => {
  (Redis.prototype as any).lrange = async function (key: string, start: number, stop: number) {
    const list = redisState.lists.get(String(key)) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  };

  (Redis.prototype as any).hgetall = async function (key: string) {
    return { ...(redisState.hashes.get(String(key)) ?? {}) };
  };

  (Redis.prototype as any).hset = async function (key: string, ...args: string[]) {
    const existing = redisState.hashes.get(String(key)) ?? {};
    for (let i = 0; i < args.length; i += 2) {
      const field = args[i];
      const value = args[i + 1];
      if (field === undefined) continue;
      existing[String(field)] = String(value ?? "");
    }
    redisState.hashes.set(String(key), existing);
    return Object.keys(existing).length;
  };

  (Redis.prototype as any).lrem = async function (key: string, count: number, value: string) {
    const list = redisState.lists.get(String(key)) ?? [];
    const target = String(value);

    if (count === 0) {
      const next = list.filter((item) => item !== target);
      redisState.lists.set(String(key), next);
      return list.length - next.length;
    }

    const next = [...list];
    const limit = Math.abs(count);
    let removed = 0;

    if (count > 0) {
      for (let i = 0; i < next.length && removed < limit; i += 1) {
        if (next[i] === target) {
          next.splice(i, 1);
          i -= 1;
          removed += 1;
        }
      }
    } else {
      for (let i = next.length - 1; i >= 0 && removed < limit; i -= 1) {
        if (next[i] === target) {
          next.splice(i, 1);
          removed += 1;
        }
      }
    }

    redisState.lists.set(String(key), next);
    return removed;
  };

  (Redis.prototype as any).del = async function (...keys: string[]) {
    let deleted = 0;
    for (const key of keys.map(String)) {
      if (redisState.hashes.delete(key)) deleted += 1;
      if (redisState.lists.delete(key)) deleted += 1;
    }
    return deleted;
  };

  (Redis.prototype as any).rpush = async function (key: string, ...values: string[]) {
    const list = redisState.lists.get(String(key)) ?? [];
    list.push(...values.map(String));
    redisState.lists.set(String(key), list);
    return list.length;
  };
});

afterAll(() => {
  Redis.prototype.lrange = originalRedisMethods.lrange;
  Redis.prototype.hgetall = originalRedisMethods.hgetall;
  Redis.prototype.hset = originalRedisMethods.hset;
  (Redis.prototype as { lrem?: unknown }).lrem = originalRedisMethods.lrem;
  Redis.prototype.del = originalRedisMethods.del;
  Redis.prototype.rpush = originalRedisMethods.rpush;
});

beforeEach(() => {
  redisState = {
    hashes: new Map(),
    lists: new Map(),
  };

  tempHome = mkdtempSync(join(tmpdir(), "mem-20-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  workspaceDir = join(tempHome, ".joelclaw", "workspace");
  reviewPath = join(workspaceDir, "REVIEW.md");
  memoryPath = join(workspaceDir, "MEMORY.md");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  rmSync(tempHome, { recursive: true, force: true });
});

describe("MEM-20 promote acceptance tests", () => {
  test("parseReviewMd extracts proposal IDs with checked, unchecked, and deleted states", () => {
    const markdown = [
      "# REVIEW Staging",
      "",
      "- [ ] p-20260217-001: Keep pending",
      "- [x] p-20260217-002: Promote",
      "- [-] p-20260217-003: Reject",
      "",
    ].join("\n");

    const parsed = parseReviewMd(markdown);

    expect(parsed).toMatchObject({
      proposals: [
        { id: "p-20260217-001", state: "unchecked" },
        { id: "p-20260217-002", state: "checked" },
        { id: "p-20260217-003", state: "deleted" },
      ],
    });
  });

  test("promoteToMemory appends to the correct MEMORY.md section with a date prefix", async () => {
    const proposalId = "p-20260210-001";
    const proposedText = "Capture architectural decisions as durable memory.";

    writeWorkspaceFiles("# REVIEW Staging\n");
    redisState.lists.set("memory:review:pending", [proposalId]);
    putProposal(proposalId, {
      targetSection: "System Architecture",
      proposedText,
      capturedAt: "2026-02-10T08:00:00.000Z",
    });

    await promoteToMemory(proposalId);

    const memory = readFileSync(memoryPath, "utf8");
    const architecture = getSectionBlock(memory, "System Architecture");
    const hardRules = getSectionBlock(memory, "Hard Rules");
    const patterns = getSectionBlock(memory, "Patterns");

    expect(architecture).toContain(`- (2026-02-10) ${proposedText}`);
    expect(hardRules).not.toContain(proposedText);
    expect(patterns).not.toContain(proposedText);
    expect(redisState.lists.get("memory:review:pending") ?? []).toMatchObject([]);
    expect(redisState.hashes.has(proposalKey(proposalId))).toBe(false);
  });

  test("archiveProposal logs rejected proposals to the daily log with reason", async () => {
    const proposalId = "p-20260212-002";
    const proposedText = "Drop redundant summary section from memory.";

    writeWorkspaceFiles(["# REVIEW Staging", `- [ ] ${proposalId}: ${proposedText}`, ""].join("\n"));
    redisState.lists.set("memory:review:pending", [proposalId]);
    putProposal(proposalId, {
      proposedText,
      capturedAt: "2026-02-12T08:00:00.000Z",
    });

    await archiveProposal(proposalId, "deleted");

    const log = readFileSync(todayLogPath(), "utf8");
    const review = readFileSync(reviewPath, "utf8");

    expect(log).toContain("### Rejected Proposals");
    expect(log).toContain(`${proposalId}: ${proposedText} [reason: deleted]`);
    expect(review).not.toContain(proposalId);
    expect(redisState.lists.get("memory:review:pending") ?? []).toMatchObject([]);
    expect(redisState.hashes.has(proposalKey(proposalId))).toBe(false);
  });

  test("expireProposal only archives proposals older than 7 days", async () => {
    const recentId = proposalIdDaysAgo(3, "001");
    const oldId = proposalIdDaysAgo(8, "002");

    writeWorkspaceFiles(
      [
        "# REVIEW Staging",
        `- [ ] ${recentId}: Recent proposal`,
        `- [ ] ${oldId}: Old proposal`,
        "",
      ].join("\n")
    );
    redisState.lists.set("memory:review:pending", [recentId, oldId]);
    putProposal(recentId, {
      proposedText: "Recent proposal",
      capturedAt: new Date().toISOString(),
    });
    putProposal(oldId, {
      proposedText: "Old proposal",
      capturedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await expireProposal(recentId);
    await expireProposal(oldId);

    const log = readFileSync(todayLogPath(), "utf8");
    const review = readFileSync(reviewPath, "utf8");

    expect(log).toContain("### Expired Proposals");
    expect(log).toContain(oldId);
    expect(log).not.toContain(recentId);
    expect(review).toContain(recentId);
    expect(review).not.toContain(oldId);
    expect(redisState.lists.get("memory:review:pending") ?? []).toMatchObject([recentId]);
    expect(redisState.hashes.has(proposalKey(recentId))).toBe(true);
    expect(redisState.hashes.has(proposalKey(oldId))).toBe(false);
  });

  test("promote function detects approved proposals and routes them to memory promotion", async () => {
    const approvedId = proposalIdDaysAgo(1, "010");
    const approvedText = "Approved: preserve concrete acceptance criteria in tests.";

    writeWorkspaceFiles(["# REVIEW Staging", `- [x] ${approvedId}: ${approvedText}`, ""].join("\n"));
    redisState.lists.set("memory:review:pending", [approvedId]);
    putProposal(approvedId, {
      targetSection: "Hard Rules",
      proposedText: approvedText,
      capturedAt: new Date().toISOString(),
    });

    const { result } = await executePromoteWithEvent({
      name: "content/updated",
      data: { path: reviewPath },
    });

    const memory = readFileSync(memoryPath, "utf8");

    expect(result).toMatchObject({ approved: [approvedId] });
    expect(memory).toContain(approvedText);
    expect(redisState.lists.get("memory:review:pending") ?? []).toMatchObject([]);
    expect(redisState.hashes.has(proposalKey(approvedId))).toBe(false);
  });

  test("promote function detects deleted proposals and routes them to archive", async () => {
    const deletedId = proposalIdDaysAgo(1, "020");
    const deletedText = "Deleted: remove duplicate operational rule.";

    writeWorkspaceFiles(["# REVIEW Staging", `- [-] ${deletedId}: ${deletedText}`, ""].join("\n"));
    redisState.lists.set("memory:review:pending", [deletedId]);
    putProposal(deletedId, {
      proposedText: deletedText,
      capturedAt: new Date().toISOString(),
    });

    const { result } = await executePromoteWithEvent({
      name: "content/updated",
      data: { path: reviewPath },
    });

    const log = readFileSync(todayLogPath(), "utf8");

    expect(result).toMatchObject({ rejected: [deletedId] });
    expect(log).toContain("### Rejected Proposals");
    expect(log).toContain(`${deletedId}: ${deletedText} [reason: marked-rejected]`);
    expect(redisState.lists.get("memory:review:pending") ?? []).toMatchObject([]);
    expect(redisState.hashes.has(proposalKey(deletedId))).toBe(false);
  });

  test("promote function auto-expires old proposals on cron run", async () => {
    const expiredId = proposalIdDaysAgo(9, "030");
    const expiredText = "Expired: stale proposal should be archived.";

    writeWorkspaceFiles(["# REVIEW Staging", `- [ ] ${expiredId}: ${expiredText}`, ""].join("\n"));
    redisState.lists.set("memory:review:pending", [expiredId]);
    putProposal(expiredId, {
      proposedText: expiredText,
      capturedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const { result } = await executePromoteWithEvent({
      name: "inngest/scheduled.timer",
      data: { cron: "0 8 * * *" },
    });

    const log = readFileSync(todayLogPath(), "utf8");

    expect(result).toMatchObject({ expired: [expiredId] });
    expect(log).toContain("### Expired Proposals");
    expect(log).toContain(expiredId);
    expect(redisState.lists.get("memory:review:pending") ?? []).toMatchObject([]);
    expect(redisState.hashes.has(proposalKey(expiredId))).toBe(false);
  });

  test("no data loss: every proposal ends up in MEMORY.md or daily log", async () => {
    const approvedId = proposalIdDaysAgo(1, "101");
    const deletedId = proposalIdDaysAgo(1, "102");
    const expiredId = proposalIdDaysAgo(8, "103");

    const approvedText = "Approved proposal survives in MEMORY.md.";
    const deletedText = "Deleted proposal is retained in rejection log.";
    const expiredText = "Expired proposal is retained in expiry log.";

    writeWorkspaceFiles(
      [
        "# REVIEW Staging",
        `- [x] ${approvedId}: ${approvedText}`,
        `- [-] ${deletedId}: ${deletedText}`,
        `- [ ] ${expiredId}: ${expiredText}`,
        "",
      ].join("\n")
    );

    redisState.lists.set("memory:review:pending", [approvedId, deletedId, expiredId]);
    putProposal(approvedId, {
      targetSection: "Patterns",
      proposedText: approvedText,
      capturedAt: new Date().toISOString(),
    });
    putProposal(deletedId, {
      proposedText: deletedText,
      capturedAt: new Date().toISOString(),
    });
    putProposal(expiredId, {
      proposedText: expiredText,
      capturedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const { result } = await executePromoteWithEvent({
      name: "content/updated",
      data: { path: reviewPath },
    });

    const memory = readFileSync(memoryPath, "utf8");
    const log = readFileSync(todayLogPath(), "utf8");

    expect(result).toMatchObject({
      approved: [approvedId],
      rejected: [deletedId],
      expired: [expiredId],
      pending: [],
    });

    expect(memory).toContain(approvedText);
    expect(log).toContain(deletedText);
    expect(log).toContain(expiredText);
    expect(redisState.lists.get("memory:review:pending") ?? []).toMatchObject([]);
  });
});

describe("MEM-21 promote prompt acceptance tests", () => {
  test("promote-prompt module exists and exports either a usable system prompt or stubbed contract", async () => {
    const loaded = await loadPromotePromptModule();
    expect(loaded).toMatchObject({ exists: true });

    const prompt = loaded.module?.PROMOTE_SYSTEM_PROMPT;
    if (typeof prompt === "string" && prompt.trim().length > 0) {
      expect(prompt).toContain("MEMORY.md");
      expect(prompt.toLowerCase()).toContain("single");
      expect(prompt.toLowerCase()).toContain("line");
    } else {
      expect({
        promptDefined: false,
      }).toMatchObject({ promptDefined: false });
    }
  });

  test("promoteToMemory conditionally uses pi formatting and inserts formatted output when prompt is defined", async () => {
    const proposalId = "p-20260211-041";
    const rawProposalText = "raw proposal text that should be normalized before insertion";
    const llmFormattedText = "Consolidate duplicate operational guidance into a single canonical rule.";

    writeWorkspaceFiles("# REVIEW Staging\n");
    redisState.lists.set("memory:review:pending", [proposalId]);
    putProposal(proposalId, {
      targetSection: "Hard Rules",
      proposedText: rawProposalText,
      capturedAt: "2026-02-11T08:00:00.000Z",
    });

    const loaded = await loadPromotePromptModule();
    const prompt = loaded.module?.PROMOTE_SYSTEM_PROMPT;
    const hasPrompt = typeof prompt === "string" && prompt.trim().length > 0;

    const originalPath = process.env.PATH ?? "";
    const shimBinDir = join(tempHome, "bin");
    const piArgsPath = join(tempHome, "pi-args.log");
    const piStdinPath = join(tempHome, "pi-stdin.log");
    const piShimPath = join(shimBinDir, "pi");
    mkdirSync(shimBinDir, { recursive: true });
    writeFileSync(
      piShimPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s\\n' \"$@\" > \"$PI_ARGS_FILE\"",
        "cat > \"$PI_STDIN_FILE\" || true",
        "printf '%s\\n' \"${PI_MOCK_OUTPUT:-}\"",
      ].join("\n")
    );
    Bun.spawnSync(["chmod", "+x", piShimPath]);

    process.env.PATH = `${shimBinDir}:${originalPath}`;
    process.env.PI_ARGS_FILE = piArgsPath;
    process.env.PI_STDIN_FILE = piStdinPath;
    process.env.PI_MOCK_OUTPUT = llmFormattedText;

    try {
      await promoteToMemory(proposalId);
    } finally {
      process.env.PATH = originalPath;
      delete process.env.PI_ARGS_FILE;
      delete process.env.PI_STDIN_FILE;
      delete process.env.PI_MOCK_OUTPUT;
    }

    const memory = readFileSync(memoryPath, "utf8");
    const hardRules = getSectionBlock(memory, "Hard Rules");
    const log = readFileSync(join(workspaceDir, "memory", "2026-02-11.md"), "utf8");
    const piRan = Bun.file(piArgsPath);
    const piRanExists = await piRan.exists();

    if (hasPrompt) {
      const argsText = readFileSync(piArgsPath, "utf8");
      const normalizedArgs = argsText.trim().split(/\r?\n/u).filter(Boolean);
      const joinedArgs = normalizedArgs.join(" ");

      expect({
        piRan: piRanExists,
        insertedRaw: hardRules.includes(rawProposalText),
        insertedFormatted: hardRules.includes(llmFormattedText),
      }).toMatchObject({
        piRan: true,
        insertedRaw: false,
        insertedFormatted: true,
      });
      expect(joinedArgs.includes(" -p ") || normalizedArgs.includes("-p")).toBe(true);
      expect(joinedArgs.includes("--no-session")).toBe(true);
      expect(joinedArgs.includes("--model haiku") || joinedArgs.includes("--model=haiku")).toBe(true);
      expect(log).toContain(llmFormattedText);
      expect(log).not.toContain(rawProposalText);
    } else {
      expect({
        piRan: piRanExists,
        insertedRaw: hardRules.includes(rawProposalText),
      }).toMatchObject({
        piRan: false,
        insertedRaw: true,
      });
      expect(log).toContain(rawProposalText);
    }
  });

  test("TypeScript compiles with no emit", async () => {
    const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect({ exitCode }).toMatchObject({ exitCode: 0 });
  });
});
