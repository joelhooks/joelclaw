import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(import.meta.dir, "agent-session-audit-backup.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { home: string; backupRoot: string; receiptPath: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-session-audit-backup-"));
  roots.push(root);
  const home = join(root, "home");
  const backupRoot = join(root, "backup");
  mkdirSync(home, { recursive: true });
  return { home, backupRoot, receiptPath: join(backupRoot, "receipts", "fixture.json") };
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

type SourceReceipt = {
  key: string;
  backupStatus: string;
  backupVerification: string;
  verified: boolean;
  synced: boolean;
  rsync?: { files: number | null; transferred: number | null; bytes: number | null };
  skippedNonRegular?: string[];
  error?: string;
};

type Receipt = {
  ok: boolean;
  hosts: Array<{ host: string; errors: string[]; sources: SourceReceipt[] }>;
};

async function runAudit(
  home: string,
  extraArgs: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  const healthServer = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });
  try {
    const child = Bun.spawn(
      ["bun", scriptPath, "--central-url", `http://127.0.0.1:${healthServer.port}`, ...extraArgs],
      {
        env: { ...process.env, HOME: home, ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const code = await child.exited;
    return { code, stderr: await new Response(child.stderr).text() };
  } finally {
    healthServer.stop(true);
  }
}

function readReceipt(path: string): Receipt {
  return JSON.parse(readFileSync(path, "utf8")) as Receipt;
}

function source(receipt: Receipt, key: string): SourceReceipt {
  const found = receipt.hosts[0]?.sources.find((entry) => entry.key === key);
  if (!found) throw new Error(`missing source ${key}`);
  return found;
}

describe("agent-session audit backup", () => {
  test("rejects the retired host instead of timing out on it", async () => {
    const { home, backupRoot, receiptPath } = fixture();
    const result = await runAudit(home, [
      "--hosts",
      "flagg,panda",
      "--backup-root",
      backupRoot,
      "--receipt",
      receiptPath,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Unknown or retired audit host(s): panda");
  });

  test("defaults the host list from JOELCLAW_SESSION_AUDIT_HOSTS", async () => {
    const { home, backupRoot, receiptPath } = fixture();
    const result = await runAudit(home, ["--backup-root", backupRoot, "--receipt", receiptPath], {
      JOELCLAW_SESSION_AUDIT_HOSTS: "flagg",
    });
    expect(result.code).toBe(0);
    expect(readReceipt(receiptPath).hosts.map((host) => host.host)).toEqual(["flagg"]);
  });

  test("skips and records an out-of-tree symlink, and verifies through rsync", async () => {
    const { home, backupRoot, receiptPath } = fixture();
    const project = join(home, ".claude", "projects", "fixture-project");
    writeFile(join(project, "session-a.jsonl"), '{"a":1}\n');
    writeFile(join(project, "session-b.jsonl"), '{"b":2}\n');
    const outside = join(home, "outside-memory");
    writeFile(join(outside, "note.md"), "memory\n");
    symlinkSync(outside, join(project, "memory"));

    const result = await runAudit(home, [
      "--hosts",
      "flagg",
      "--backup-root",
      backupRoot,
      "--receipt",
      receiptPath,
    ]);
    expect(result.code).toBe(0);

    const receipt = readReceipt(receiptPath);
    const claude = source(receipt, "claude-projects");
    expect(claude.error).toBeUndefined();
    expect(claude).toMatchObject({
      synced: true,
      backupStatus: "skipped",
      backupVerification: "rsync",
      verified: true,
      rsync: { files: 2, transferred: 2 },
    });
    expect(claude.skippedNonRegular).toEqual(["fixture-project/memory"]);
    expect(
      readFileSync(
        join(backupRoot, "flagg", "claude-projects", "fixture-project", "session-a.jsonl"),
        "utf8",
      ),
    ).toBe('{"a":1}\n');
    expect(receipt.hosts[0]?.errors).toEqual([]);
    expect(receipt.ok).toBe(true);
  });

  test("walks the destination when sync is off and reports stat verification", async () => {
    const { home, backupRoot, receiptPath } = fixture();
    writeFile(join(home, ".codex", "sessions", "one.jsonl"), "{}\n");
    writeFile(join(backupRoot, "flagg", "codex-sessions", "one.jsonl"), "{}\n");

    const result = await runAudit(home, [
      "--hosts",
      "flagg",
      "--sync=false",
      "--backup-root",
      backupRoot,
      "--receipt",
      receiptPath,
    ]);
    expect(result.code).toBe(0);
    expect(source(readReceipt(receiptPath), "codex-sessions")).toMatchObject({
      synced: false,
      backupStatus: "ok",
      backupVerification: "stat",
      verified: true,
    });
  });

  test("a destination walk timeout stays unverified and fails the receipt", async () => {
    const { home, backupRoot, receiptPath } = fixture();
    writeFile(join(home, ".codex", "sessions", "one.jsonl"), "{}\n");

    const result = await runAudit(home, [
      "--hosts",
      "flagg",
      "--sync=false",
      "--stat-timeout-ms",
      "1",
      "--backup-root",
      backupRoot,
      "--receipt",
      receiptPath,
    ]);
    expect(result.code).toBe(0);
    const receipt = readReceipt(receiptPath);
    expect(source(receipt, "codex-sessions")).toMatchObject({
      backupStatus: "timeout",
      backupVerification: "none",
      verified: false,
    });
    expect(receipt.ok).toBe(false);
  });
});
