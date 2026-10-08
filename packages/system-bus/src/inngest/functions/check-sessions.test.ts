import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSessions } from "./check-sessions";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
let sandbox: string | undefined;
const originalHome = process.env.HOME;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("sessions/prune.requested reports old files and leaves both harness directories untouched", async () => {
  sandbox = await mkdtemp(join(tmpdir(), "check-sessions-report-only-"));
  const homeDir = join(sandbox, "home");
  const oldPiSession = join(homeDir, ".pi", "agent", "sessions", "old.jsonl");
  const oldClaudeDebug = join(homeDir, ".claude", "debug", "old.log");
  await Promise.all([
    mkdir(join(homeDir, ".pi", "agent", "sessions"), { recursive: true }),
    mkdir(join(homeDir, ".claude", "debug"), { recursive: true }),
  ]);
  await Promise.all([writeFile(oldPiSession, "fixture"), writeFile(oldClaudeDebug, "fixture")]);
  const oldDate = new Date(Date.now() - THIRTY_DAYS_MS - 60_000);
  await Promise.all([
    utimes(oldPiSession, oldDate, oldDate),
    utimes(oldClaudeDebug, oldDate, oldDate),
  ]);
  process.env.HOME = homeDir;

  const runStep = async <T>(_id: string, operation: () => Promise<T>): Promise<T> => operation();
  const handler = (
    checkSessions as unknown as {
      fn: (input: { step: { run: typeof runStep } }) => Promise<unknown>;
    }
  ).fn;
  const result = (await handler({ step: { run: runStep } })) as Record<string, unknown>;

  expect(await exists(oldPiSession)).toBe(true);
  expect(await exists(oldClaudeDebug)).toBe(true);
  expect(result).toMatchObject({
    status: "reported",
    mode: "report_only",
    wouldPruneSessions: 1,
    wouldPruneDebug: 1,
    totalWouldPrune: 2,
  });
});
