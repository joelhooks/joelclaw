import { afterEach, describe, expect, mock, test } from "bun:test";

type InngestTrigger = { event?: string };
type InngestFunctionLike = {
  opts?: {
    id?: string;
    triggers?: InngestTrigger[];
  };
};

type ServeOptions = {
  client?: unknown;
  functions?: InngestFunctionLike[];
};

function cacheBuster(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function collectEventTriggerKeys(functions: InngestFunctionLike[]): string[] {
  return functions.flatMap((fn) => {
    const id = fn?.opts?.id ?? "unknown";
    const triggers = fn?.opts?.triggers ?? [];

    return triggers
      .map((trigger) => trigger?.event)
      .filter((eventName): eventName is string => typeof eventName === "string")
      .map((eventName) => `${id}::${eventName}`);
  });
}

afterEach(() => {
  mock.restore();
});

describe("OBS-6: register observeSessionFunction in index.ts and serve.ts", () => {
  test("AC-1 and AC-4: functions barrel exports observeSessionFunction as the canonical observe function", async () => {
    const functionsModule = await import("../src/inngest/functions/index.ts");
    const observeModule = await import("../src/inngest/functions/observe.ts");

    expect(functionsModule).toMatchObject({
      observeSessionFunction: expect.any(Object),
    });

    expect((functionsModule as { observeSessionFunction?: unknown }).observeSessionFunction).toBe(
      (observeModule as { observeSessionFunction?: unknown }).observeSessionFunction
    );
  });

  test("AC-2, AC-3, and AC-4: serve.ts registers observeSessionFunction with no duplicate event triggers", async () => {
    let capturedServeOptions: ServeOptions | undefined;

    mock.module("inngest/hono", () => ({
      serve: (options: ServeOptions) => {
        capturedServeOptions = options;
        return () => new Response("ok", { status: 200 });
      },
    }));

    await import(`../src/serve.ts?${cacheBuster("obs6-serve")}`);

    expect(capturedServeOptions).toMatchObject({
      client: expect.any(Object),
      functions: expect.any(Array),
    });

    const observeModule = await import("../src/inngest/functions/observe.ts");

    const registeredFunctions = (capturedServeOptions?.functions ?? []) as InngestFunctionLike[];
    const observeFn = (observeModule as { observeSessionFunction?: InngestFunctionLike })
      .observeSessionFunction;

    expect(observeFn).toMatchObject({
      opts: {
        id: "memory/observe-session",
      },
    });

    const observeByIdentity = registeredFunctions.filter((fn) => fn === observeFn);
    const observeById = registeredFunctions.filter(
      (fn) => fn?.opts?.id === "memory/observe-session"
    );

    expect(observeByIdentity.length).toBe(1);
    expect(observeById.length).toBe(1);

    const triggerKeys = collectEventTriggerKeys(registeredFunctions);
    const uniqueTriggerKeys = new Set(triggerKeys);

    expect(triggerKeys.length).toBe(uniqueTriggerKeys.size);

    const observeTriggers = observeFn?.opts?.triggers ?? [];
    const observeEvents = observeTriggers
      .map((trigger) => trigger.event)
      .filter((eventName): eventName is string => typeof eventName === "string");

    expect(observeEvents).toEqual(
      expect.arrayContaining([
        "memory/session.compaction.pending",
        "memory/session.ended",
      ])
    );
  });

  test(
    "AC-5: TypeScript compiles cleanly with bunx tsc --noEmit",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        console.error("tsc stdout:", stdout);
        console.error("tsc stderr:", stderr);
      }

      expect(exitCode).toBe(0);
    },
    30_000
  );
});
