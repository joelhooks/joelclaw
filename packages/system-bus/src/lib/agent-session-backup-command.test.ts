import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentSessionBackupCommand } from "./agent-session-backup-command";

let fixtureRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

describe("scheduled agent-session backup command", () => {
  test("executes the audit backup without removed replay flags", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "agent-session-backup-command-"));
    const backupRoot = join(fixtureRoot, "backup");
    const receiptPath = join(backupRoot, "receipts", "fixture.json");
    const healthServer = Bun.serve({
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/runs/health");
        return Response.json({ ok: true });
      },
    });
    const command = buildAgentSessionBackupCommand({
      scriptPath: join(process.cwd(), "scripts", "agent-session-audit-backup.ts"),
      hosts: "flagg",
      backupRoot,
      centralUrl: `http://127.0.0.1:${healthServer.port}`,
      receiptPath,
      repairEnv: false,
    });

    try {
      expect(command).not.toContain("--replay-outbox");
      expect(command).not.toContain("--replay-limit");
      expect(command).not.toContain("--replay-max-bytes");
      const child = Bun.spawn(command, {
        cwd: process.cwd(),
        env: { ...process.env, HOME: fixtureRoot },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      expect(existsSync(receiptPath)).toBe(true);
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
        backupRoot,
        sync: true,
        hosts: [{ host: "flagg", centralHealthOk: true }],
      });
    } finally {
      healthServer.stop(true);
    }
  });
});
