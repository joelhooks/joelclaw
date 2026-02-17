import { describe, expect, test } from "bun:test";

type MockCommandResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

type StepMockOptions = {
  canned?: Record<string, unknown>;
  passthroughRunIds?: string[];
  runCalls?: string[];
};

function makeStepMock(options: StepMockOptions) {
  const canned = options.canned ?? {};
  const passthrough = new Set(options.passthroughRunIds ?? []);
  const runCalls = options.runCalls ?? [];

  return {
    run: async (id: string, work: () => Promise<unknown>) => {
      runCalls.push(id);
      if (id in canned) return canned[id];
      if (passthrough.has(id)) return work();
      throw new Error(`Unexpected step.run id: ${id}`);
    },
  };
}

function renderCommand(parts: TemplateStringsArray, values: unknown[]) {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    out += parts[i] ?? "";
    if (i < values.length) out += String(values[i]);
  }

  return out.replace(/\s+/g, " ").trim();
}

function withMockShell(
  resolver: (command: string) => MockCommandResult,
  testFn: (calls: string[]) => Promise<void>
) {
  const originalDollar = Bun.$;
  const calls: string[] = [];

  class MockInvocation {
    private resolved = false;
    private result: Required<MockCommandResult> = {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };

    constructor(private readonly command: string) {}

    private ensureResolved() {
      if (this.resolved) return;
      this.resolved = true;
      calls.push(this.command);
      const value = resolver(this.command);
      this.result = {
        exitCode: value.exitCode ?? 0,
        stdout: value.stdout ?? "",
        stderr: value.stderr ?? "",
      };
    }

    quiet() {
      return this;
    }

    async nothrow() {
      this.ensureResolved();
      return this;
    }

    text() {
      this.ensureResolved();
      return this.result.stdout;
    }

    get exitCode() {
      this.ensureResolved();
      return this.result.exitCode;
    }

    get stderr() {
      this.ensureResolved();
      return this.result.stderr;
    }
  }

  (Bun as any).$ = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const command = renderCommand(parts, values);
    return new MockInvocation(command);
  };

  return testFn(calls).finally(() => {
    (Bun as any).$ = originalDollar;
  });
}

function makeCompletedEvent(loopId: string) {
  return {
    name: "agent/loop.completed",
    data: {
      loopId,
      project: "/tmp/project-under-test",
      branchName: "loop-branch",
      storiesCompleted: 1,
      storiesFailed: 0,
      workDir: `/tmp/agent-loop/${loopId}`,
    },
  };
}

describe("SYNC-1 acceptance tests: complete.ts worker sync handles dirty state", () => {
  test("AC-1 + AC-3: sync-worker-clone tries git pull --ff-only first and still runs bun install on success path", async () => {
    await withMockShell(
      (command) => {
        if (command.includes("id -u")) return { stdout: "501\n" };
        if (command.includes("git pull --ff-only")) return { exitCode: 0 };
        if (command.includes("bun install --silent")) return { exitCode: 0 };
        return { exitCode: 0 };
      },
      async (calls) => {
        const mod = await import(`./complete.ts?sync1-fast=${Date.now()}`);
        const fn = (mod.agentLoopComplete as unknown as { fn: (input: unknown) => Promise<unknown> })
          .fn;

        const runCalls: string[] = [];

        const result = await fn({
          event: makeCompletedEvent(`sync1-fast-${Date.now()}`),
          step: makeStepMock({
            canned: {
              "merge-to-main": { merged: true },
              "cleanup-worktree": { cleaned: true },
              "push-to-remote": "skipped-in-test",
            },
            passthroughRunIds: ["sync-worker-clone"],
            runCalls,
          }),
        });

        expect(result).toMatchObject({
          status: "merged",
          syncResult: { synced: true },
        });

        expect(runCalls).toContain("sync-worker-clone");

        const pullIndex = calls.findIndex((c) => c.includes("git pull --ff-only"));
        const installIndex = calls.findIndex((c) => c.includes("bun install --silent"));
        const fallbackIndex = calls.findIndex((c) =>
          c.includes("git fetch origin && git reset --hard origin/main && git clean -fd")
        );

        expect(pullIndex).toBeGreaterThanOrEqual(0);
        expect(installIndex).toBeGreaterThan(pullIndex);
        expect(fallbackIndex).toBe(-1);
      }
    );
  });

  test("AC-2 + AC-3: on pull failure it falls back to fetch/reset/clean, then runs bun install", async () => {
    await withMockShell(
      (command) => {
        if (command.includes("id -u")) return { stdout: "501\n" };
        if (command.includes("git pull --ff-only")) {
          return { exitCode: 1, stderr: "fatal: Not possible to fast-forward" };
        }
        if (command.includes("git fetch origin && git reset --hard origin/main && git clean -fd")) {
          return { exitCode: 0 };
        }
        if (command.includes("bun install --silent")) return { exitCode: 0 };
        return { exitCode: 0 };
      },
      async (calls) => {
        const mod = await import(`./complete.ts?sync1-fallback=${Date.now()}`);
        const fn = (mod.agentLoopComplete as unknown as { fn: (input: unknown) => Promise<unknown> })
          .fn;

        const result = await fn({
          event: makeCompletedEvent(`sync1-fallback-${Date.now()}`),
          step: makeStepMock({
            canned: {
              "merge-to-main": { merged: true },
              "cleanup-worktree": { cleaned: true },
              "push-to-remote": "skipped-in-test",
            },
            passthroughRunIds: ["sync-worker-clone"],
          }),
        });

        expect(result).toMatchObject({
          status: "merged",
          syncResult: { synced: true },
        });

        const pullIndex = calls.findIndex((c) => c.includes("git pull --ff-only"));
        const fallbackIndex = calls.findIndex((c) =>
          c.includes("git fetch origin && git reset --hard origin/main && git clean -fd")
        );
        const installIndex = calls.findIndex((c) => c.includes("bun install --silent"));

        expect(pullIndex).toBeGreaterThanOrEqual(0);
        expect(fallbackIndex).toBeGreaterThan(pullIndex);
        expect(installIndex).toBeGreaterThan(fallbackIndex);
      }
    );
  });

  test("AC-4: TypeScript compiles with bunx tsc --noEmit", async () => {
    const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

    expect({ exitCode, stderr }).toMatchObject({
      exitCode: 0,
    });
  });
});
