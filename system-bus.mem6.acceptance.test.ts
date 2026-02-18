import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promote } from "./packages/system-bus/src/inngest/functions/promote";

const REPO_ROOT = import.meta.dir;
const SYSTEM_BUS_DIR = join(REPO_ROOT, "packages", "system-bus");
const REVIEW_PATH = join(homedir(), ".joelclaw", "workspace", "REVIEW.md");

function runCommand(command: string, args: string[], cwd = REPO_ROOT) {
  const proc = Bun.spawnSync([command, ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

describe("MEM-6 acceptance: review cleanup and validation", () => {
  test("AC-1: ~/.joelclaw/workspace/REVIEW.md does not exist", () => {
    expect({
      reviewFileExists: existsSync(REVIEW_PATH),
    }).toMatchObject({
      reviewFileExists: false,
    });
  });

  test("AC-2: no REVIEW.md references remain in packages/system-bus/src non-test source", () => {
    const result = runCommand("grep", [
      "-rl",
      "--include=*.ts",
      "--exclude=*.test.ts",
      "REVIEW\\.md",
      "packages/system-bus/src",
    ]);

    expect(result).toMatchObject({
      exitCode: 1,
    });
  });

  test("AC-extra: promote function exposes approved/rejected triggers", () => {
    const triggerDefs = (((promote as any).opts?.triggers ?? []) as Array<Record<string, unknown>>).map((trigger) => ({
      event: trigger.event,
      cron: trigger.cron,
    }));

    expect({
      hasApprovedTrigger: triggerDefs.some((trigger) => trigger.event === "memory/proposal.approved"),
      hasRejectedTrigger: triggerDefs.some((trigger) => trigger.event === "memory/proposal.rejected"),
    }).toMatchObject({
      hasApprovedTrigger: true,
      hasRejectedTrigger: true,
    });
  });

  test("AC-3: full package test suite passes in packages/system-bus", () => {
    const result = runCommand("bun", ["test"], SYSTEM_BUS_DIR);

    expect(result).toMatchObject({
      exitCode: 0,
    });
  });

  test("AC-4: TypeScript compiles in packages/system-bus with bunx tsc --noEmit", () => {
    const result = runCommand("bunx", ["tsc", "--noEmit"], SYSTEM_BUS_DIR);

    expect(result).toMatchObject({
      exitCode: 0,
    });
  });
});
