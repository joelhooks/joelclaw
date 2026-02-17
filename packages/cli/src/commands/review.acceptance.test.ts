import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "@effect/cli";
import { Effect } from "effect";
import { Inngest } from "../inngest";

type ProposalHash = Record<string, string>;

const redisState = {
  pendingIds: [] as string[],
  proposals: new Map<string, ProposalHash>(),
  calls: {
    lrange: [] as Array<{ key: string; start: number; stop: number }>,
    hgetall: [] as string[],
  },
};

class MockRedis {
  async connect() {
    return this;
  }

  async lrange(key: string, start: number, stop: number) {
    redisState.calls.lrange.push({ key, start, stop });
    if (key === "memory:review:pending") {
      return [...redisState.pendingIds];
    }
    return [];
  }

  async hgetall(key: string) {
    redisState.calls.hgetall.push(key);
    const id = key.replace("memory:review:proposal:", "");
    return redisState.proposals.get(id) ?? {};
  }

  async quit() {
    return "OK";
  }

  disconnect() {}
}

mock.module("ioredis", () => ({
  default: MockRedis,
}));

function makeInngestMock() {
  const sends: Array<{ name: string; data: Record<string, unknown> }> = [];

  const service = {
    send: (name: string, data: Record<string, unknown>) =>
      Effect.sync(() => {
        sends.push({ name, data });
        return { ids: [`evt-${sends.length}`] };
      }),
    functions: () => Effect.succeed([]),
    runs: () => Effect.succeed([]),
    run: () => Effect.succeed({}),
    events: () => Effect.succeed([]),
    health: () => Effect.succeed({}),
  };

  return { service, sends };
}

async function executeReview(
  reviewCmd: any,
  args: string[],
  serviceOverride?: unknown
) {
  const root = Command.make("joelclaw", {}, () => Effect.succeed(undefined)).pipe(
    Command.withSubcommands([reviewCmd])
  );
  const run = Command.run(root, { name: "joelclaw", version: "test" });
  const logs: string[] = [];
  const originalLog = console.log;

  console.log = (...parts: unknown[]) => {
    logs.push(parts.map((part) => String(part)).join(" "));
  };

  try {
    let program = run(["bun", "cli.ts", ...args]);
    if (serviceOverride) {
      program = program.pipe(Effect.provideService(Inngest, serviceOverride as any));
    }
    await Effect.runPromise(program);
  } finally {
    console.log = originalLog;
  }

  const parsed = logs
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return {
    logs,
    json: parsed[parsed.length - 1] as Record<string, unknown> | undefined,
  };
}

async function runReviewListWithFallback(reviewCmd: any) {
  let lastError: unknown = null;
  for (const args of [
    ["review", "list"],
    ["review"],
  ]) {
    try {
      return await executeReview(reviewCmd, args);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function findObjectsWithActions(node: unknown): Array<Record<string, unknown>> {
  if (!node || typeof node !== "object") return [];

  const current = node as Record<string, unknown>;
  const out: Array<Record<string, unknown>> = [];

  if ("_actions" in current) {
    out.push(current);
  }

  for (const value of Object.values(current)) {
    if (Array.isArray(value)) {
      for (const item of value) out.push(...findObjectsWithActions(item));
    } else if (value && typeof value === "object") {
      out.push(...findObjectsWithActions(value));
    }
  }

  return out;
}

function actionTexts(actions: unknown): string[] {
  if (Array.isArray(actions)) {
    return actions.map((a) => {
      if (typeof a === "string") return a;
      if (a && typeof a === "object" && "command" in a) {
        const command = (a as Record<string, unknown>).command;
        return typeof command === "string" ? command : JSON.stringify(a);
      }
      return JSON.stringify(a);
    });
  }

  if (actions && typeof actions === "object") {
    return Object.values(actions).map((a) => {
      if (typeof a === "string") return a;
      if (a && typeof a === "object" && "command" in a) {
        const command = (a as Record<string, unknown>).command;
        return typeof command === "string" ? command : JSON.stringify(a);
      }
      return JSON.stringify(a);
    });
  }

  return [];
}

beforeEach(() => {
  redisState.pendingIds = [];
  redisState.proposals = new Map();
  redisState.calls.lrange = [];
  redisState.calls.hgetall = [];
});

describe("MEM-4 acceptance: joelclaw review CLI", () => {
  test("AC-1: review command module exists and exports reviewCmd", async () => {
    const mod = await import("./review.ts");
    expect(mod).toMatchObject({
      reviewCmd: expect.anything(),
    });
  });

  test("AC-2: review command is registered in root CLI", () => {
    const proc = Bun.spawnSync(["bun", "run", "packages/cli/src/cli.ts", "review", "--help"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(proc.exitCode).toBe(0);
    const helpText = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
    expect(helpText).toContain("review");
  });

  test("AC-3: review list reads Redis and outputs HATEOAS JSON with approve/reject actions", async () => {
    redisState.pendingIds = ["p-1", "p-2"];
    redisState.proposals.set("p-1", {
      id: "p-1",
      title: "Proposal one",
      createdAt: "2026-02-16T12:00:00.000Z",
    });
    redisState.proposals.set("p-2", {
      id: "p-2",
      title: "Proposal two",
      createdAt: "2026-02-17T10:00:00.000Z",
    });

    const mod = await import("./review.ts");
    const result = await runReviewListWithFallback(mod.reviewCmd);

    expect(redisState.calls.lrange[0]).toMatchObject({
      key: "memory:review:pending",
      start: 0,
      stop: -1,
    });
    expect(redisState.calls.hgetall).toMatchObject([
      "memory:review:proposal:p-1",
      "memory:review:proposal:p-2",
    ]);

    expect(result.json).toMatchObject({
      ok: true,
      command: expect.stringContaining("review"),
    });

    const withActions = findObjectsWithActions(result.json);
    expect(withActions.length).toBeGreaterThan(0);
    const texts = withActions.flatMap((entry) => actionTexts(entry._actions));
    expect(texts.some((text) => text.includes("approve"))).toBe(true);
    expect(texts.some((text) => text.includes("reject"))).toBe(true);
  });

  test("AC-4: review approve sends memory/proposal.approved", async () => {
    const { service, sends } = makeInngestMock();
    const mod = await import("./review.ts");

    await executeReview(mod.reviewCmd, ["review", "approve", "p-123"], service);

    expect(sends.length).toBeGreaterThan(0);
    expect(sends[0]).toMatchObject({
      name: "memory/proposal.approved",
      data: {
        proposalId: "p-123",
        approvedBy: "joel",
      },
    });
  });

  test("AC-5: review reject --reason sends memory/proposal.rejected", async () => {
    const { service, sends } = makeInngestMock();
    const mod = await import("./review.ts");

    await executeReview(
      mod.reviewCmd,
      ["review", "reject", "p-456", "--reason", "Needs stronger evidence"],
      service
    );

    expect(sends.length).toBeGreaterThan(0);
    expect(sends[0]).toMatchObject({
      name: "memory/proposal.rejected",
      data: {
        proposalId: "p-456",
        reason: "Needs stronger evidence",
      },
    });
  });

  test("AC-6: review approve-all sends one approved event per pending proposal", async () => {
    redisState.pendingIds = ["p-11", "p-22", "p-33"];
    const { service, sends } = makeInngestMock();
    const mod = await import("./review.ts");

    await executeReview(mod.reviewCmd, ["review", "approve-all"], service);

    expect(redisState.calls.lrange[0]).toMatchObject({
      key: "memory:review:pending",
      start: 0,
      stop: -1,
    });
    expect(sends.length).toBe(3);
    expect(sends).toMatchObject([
      { name: "memory/proposal.approved", data: { proposalId: "p-11", approvedBy: "joel" } },
      { name: "memory/proposal.approved", data: { proposalId: "p-22", approvedBy: "joel" } },
      { name: "memory/proposal.approved", data: { proposalId: "p-33", approvedBy: "joel" } },
    ]);
  });

  test("AC-7: TypeScript compiles with bunx tsc --noEmit", () => {
    const proc = Bun.spawnSync(["bunx", "tsc", "--noEmit"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(proc.exitCode).toBe(0);
  });
});
