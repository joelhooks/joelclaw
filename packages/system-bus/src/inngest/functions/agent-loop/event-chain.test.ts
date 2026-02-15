import { test, expect, describe } from "bun:test";

/**
 * ADR-0019: Event chain tests — verify each function triggers on and emits the correct past-tense events.
 *
 * Chain: started → story.dispatched → tests.written → code.committed
 *          → checks.completed → story.passed/failed/retried → completed
 */

// ── AC-1: plan.ts triggers and emissions ──────────────────────────────
describe("AC-1: plan.ts triggers on started/story.passed/story.failed, emits story.dispatched + completed", () => {
  test("agentLoopPlan triggers on agent/loop.started, story.passed, and story.failed", async () => {
    const mod = await import("./plan.ts");
    const fn = mod.agentLoopPlan as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.started");
    expect(eventNames).toContain("agent/loop.story.passed");
    expect(eventNames).toContain("agent/loop.story.failed");
  });

  test("plan.ts source emits agent/loop.story.dispatched", async () => {
    const source = await Bun.file(
      new URL("./plan.ts", import.meta.url).pathname
    ).text();
    expect(source).toContain('"agent/loop.story.dispatched"');
  });

  test("plan.ts source emits agent/loop.completed", async () => {
    const source = await Bun.file(
      new URL("./plan.ts", import.meta.url).pathname
    ).text();
    expect(source).toContain('"agent/loop.completed"');
  });
});

// ── AC-2: test-writer.ts triggers and emissions ───────────────────────
describe("AC-2: test-writer.ts triggers on story.dispatched, emits tests.written", () => {
  test("agentLoopTestWriter triggers on agent/loop.story.dispatched", async () => {
    const mod = await import("./test-writer.ts");
    const fn = mod.agentLoopTestWriter as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.story.dispatched");
  });

  test("test-writer.ts emits agent/loop.tests.written", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();
    expect(source).toContain('"agent/loop.tests.written"');
  });
});

// ── AC-3: implement.ts triggers and emissions ─────────────────────────
describe("AC-3: implement.ts triggers on tests.written + story.retried, emits code.committed", () => {
  test("agentLoopImplement triggers on agent/loop.tests.written and story.retried", async () => {
    const mod = await import("./implement.ts");
    const fn = mod.agentLoopImplement as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.tests.written");
    expect(eventNames).toContain("agent/loop.story.retried");
  });

  test("implement.ts emits agent/loop.code.committed", async () => {
    const source = await Bun.file(
      new URL("./implement.ts", import.meta.url).pathname
    ).text();
    expect(source).toContain('"agent/loop.code.committed"');
  });
});

// ── AC-4: review.ts triggers and emissions ────────────────────────────
describe("AC-4: review.ts triggers on code.committed, emits checks.completed", () => {
  test("agentLoopReview triggers on agent/loop.code.committed", async () => {
    const mod = await import("./review.ts");
    const fn = mod.agentLoopReview as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.code.committed");
  });

  test("review.ts emits agent/loop.checks.completed", async () => {
    const source = await Bun.file(
      new URL("./review.ts", import.meta.url).pathname
    ).text();
    expect(source).toContain('"agent/loop.checks.completed"');
  });
});

// ── AC-5: judge.ts triggers and emissions ─────────────────────────────
describe("AC-5: judge.ts triggers on checks.completed, emits story.passed/failed/retried", () => {
  test("agentLoopJudge triggers on agent/loop.checks.completed", async () => {
    const mod = await import("./judge.ts");
    const fn = mod.agentLoopJudge as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.checks.completed");
  });

  test("judge.ts emits agent/loop.story.passed", async () => {
    const source = await Bun.file(
      new URL("./judge.ts", import.meta.url).pathname
    ).text();
    expect(source).toContain('"agent/loop.story.passed"');
  });

  test("judge.ts emits agent/loop.story.failed", async () => {
    const source = await Bun.file(
      new URL("./judge.ts", import.meta.url).pathname
    ).text();
    expect(source).toContain('"agent/loop.story.failed"');
  });

  test("judge.ts retry path emits agent/loop.story.retried", async () => {
    const source = await Bun.file(
      new URL("./judge.ts", import.meta.url).pathname
    ).text();
    expect(source).toContain('"agent/loop.story.retried"');
  });
});

// ── AC-6: Full chain links correctly ──────────────────────────────────
describe("AC-6: Full event chain is started → dispatched → tests.written → code.committed → checks.completed", () => {
  test("event chain links correctly end-to-end", async () => {
    const [plan, tw, impl, rev, judge] = await Promise.all([
      import("./plan.ts"),
      import("./test-writer.ts"),
      import("./implement.ts"),
      import("./review.ts"),
      import("./judge.ts"),
    ]);

    const triggers = (fn: any) => (fn.opts?.triggers ?? []).map((t: any) => t.event);

    // plan triggers on started + story.passed + story.failed
    expect(triggers(plan.agentLoopPlan)).toContain("agent/loop.started");
    expect(triggers(plan.agentLoopPlan)).toContain("agent/loop.story.passed");

    // test-writer triggers on story.dispatched (emitted by plan)
    expect(triggers(tw.agentLoopTestWriter)).toContain("agent/loop.story.dispatched");

    // implement triggers on tests.written (emitted by test-writer) + story.retried (from judge)
    expect(triggers(impl.agentLoopImplement)).toContain("agent/loop.tests.written");
    expect(triggers(impl.agentLoopImplement)).toContain("agent/loop.story.retried");

    // review triggers on code.committed (emitted by implement)
    expect(triggers(rev.agentLoopReview)).toContain("agent/loop.code.committed");

    // judge triggers on checks.completed (emitted by review)
    expect(triggers(judge.agentLoopJudge)).toContain("agent/loop.checks.completed");
  });
});
