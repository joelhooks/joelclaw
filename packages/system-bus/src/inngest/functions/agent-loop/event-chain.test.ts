import { test, expect, describe } from "bun:test";

// ── AC-1: plan.ts emits agent/loop.test instead of agent/loop.implement ──────
describe("AC-1: plan.ts emits agent/loop.test instead of agent/loop.implement", () => {
  test("agentLoopPlan triggers on agent/loop.start and agent/loop.plan", async () => {
    const mod = await import("./plan.ts");
    const fn = mod.agentLoopPlan as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.start");
    expect(eventNames).toContain("agent/loop.plan");
  });

  test("plan.ts source emits agent/loop.test (not agent/loop.implement)", async () => {
    const source = await Bun.file(
      new URL("./plan.ts", import.meta.url).pathname
    ).text();

    // Should emit agent/loop.test
    expect(source).toContain('"agent/loop.test"');

    // Should NOT emit agent/loop.implement anywhere in plan.ts
    // (plan.ts should only emit agent/loop.test and agent/loop.complete)
    const sends = [...source.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    const emittedEvents = sends.map((m) => m[1]);
    expect(emittedEvents).toContain("test");
    expect(emittedEvents).not.toContain("implement");
  });

  test("plan.ts emit step is named 'emit-test'", async () => {
    const source = await Bun.file(
      new URL("./plan.ts", import.meta.url).pathname
    ).text();

    // The step that emits the test event should be named emit-test
    expect(source).toContain("emit-test");
  });
});

// ── AC-2: test-writer.ts emits agent/loop.implement after writing tests ──────
describe("AC-2: test-writer.ts emits agent/loop.implement after writing tests", () => {
  test("agentLoopTestWriter triggers on agent/loop.test", async () => {
    const mod = await import("./test-writer.ts");
    const fn = mod.agentLoopTestWriter as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.test");
  });

  test("test-writer.ts emits agent/loop.implement", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    expect(source).toContain('"agent/loop.implement"');
  });

  test("test-writer.ts does NOT emit agent/loop.test (no self-loop)", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    // Check send calls only — trigger declarations will mention agent/loop.test
    const sends = [...source.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    const emittedEvents = sends.map((m) => m[1]);
    expect(emittedEvents).not.toContain("test");
  });
});

// ── AC-3: implement.ts still emits agent/loop.review ─────────────────────────
describe("AC-3: implement.ts still emits agent/loop.review", () => {
  test("agentLoopImplement triggers on agent/loop.implement", async () => {
    const mod = await import("./implement.ts");
    const fn = mod.agentLoopImplement as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.implement");
  });

  test("implement.ts emits agent/loop.review", async () => {
    const source = await Bun.file(
      new URL("./implement.ts", import.meta.url).pathname
    ).text();

    expect(source).toContain('"agent/loop.review"');
  });

  test("implement.ts does NOT emit agent/loop.implement or agent/loop.test", async () => {
    const source = await Bun.file(
      new URL("./implement.ts", import.meta.url).pathname
    ).text();

    const sends = [...source.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    const emittedEvents = sends.map((m) => m[1]);
    expect(emittedEvents).not.toContain("implement");
    expect(emittedEvents).not.toContain("test");
  });
});

// ── AC-4: review.ts still emits agent/loop.judge ─────────────────────────────
describe("AC-4: review.ts still emits agent/loop.judge", () => {
  test("agentLoopReview triggers on agent/loop.review", async () => {
    const mod = await import("./review.ts");
    const fn = mod.agentLoopReview as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.review");
  });

  test("review.ts emits agent/loop.judge", async () => {
    const source = await Bun.file(
      new URL("./review.ts", import.meta.url).pathname
    ).text();

    expect(source).toContain('"agent/loop.judge"');
  });

  test("review.ts does NOT emit agent/loop.implement or agent/loop.test", async () => {
    const source = await Bun.file(
      new URL("./review.ts", import.meta.url).pathname
    ).text();

    const sends = [...source.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    const emittedEvents = sends.map((m) => m[1]);
    expect(emittedEvents).not.toContain("implement");
    expect(emittedEvents).not.toContain("test");
  });
});

// ── AC-5: Judge retry emits agent/loop.implement (skips test writing) ────────
describe("AC-5: Judge retry emits agent/loop.implement (skips test writing on retry)", () => {
  test("agentLoopJudge triggers on agent/loop.judge", async () => {
    const mod = await import("./judge.ts");
    const fn = mod.agentLoopJudge as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.judge");
  });

  test("judge.ts retry path emits agent/loop.implement (NOT agent/loop.test)", async () => {
    const source = await Bun.file(
      new URL("./judge.ts", import.meta.url).pathname
    ).text();

    // Judge should emit agent/loop.implement on retry
    const sends = [...source.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    const emittedEvents = sends.map((m) => m[1]);
    expect(emittedEvents).toContain("implement");

    // Should NOT emit agent/loop.test — on retry, tests already exist
    expect(emittedEvents).not.toContain("test");
  });

  test("judge.ts retry step is named with 'retry' (not 'test')", async () => {
    const source = await Bun.file(
      new URL("./judge.ts", import.meta.url).pathname
    ).text();

    // The retry step should reference implement, not test
    expect(source).toMatch(/emit-retry-implement/);
  });
});

// ── AC-6: Full chain ordering: plan→test→implement→review→judge ──────────────
describe("AC-6: Full event chain is plan→test→implement→review→judge", () => {
  test("event chain links correctly end-to-end", async () => {
    // Verify the complete chain by checking each function's trigger→emit pair
    const planSource = await Bun.file(
      new URL("./plan.ts", import.meta.url).pathname
    ).text();
    const testWriterSource = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();
    const implementSource = await Bun.file(
      new URL("./implement.ts", import.meta.url).pathname
    ).text();
    const reviewSource = await Bun.file(
      new URL("./review.ts", import.meta.url).pathname
    ).text();
    const judgeSource = await Bun.file(
      new URL("./judge.ts", import.meta.url).pathname
    ).text();

    // plan emits → test
    const planSends = [...planSource.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    expect(planSends.map((m) => m[1])).toContain("test");

    // test-writer emits → implement
    const twSends = [...testWriterSource.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    expect(twSends.map((m) => m[1])).toContain("implement");

    // implement emits → review
    const implSends = [...implementSource.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    expect(implSends.map((m) => m[1])).toContain("review");

    // review emits → judge
    const revSends = [...reviewSource.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    expect(revSends.map((m) => m[1])).toContain("judge");

    // judge retry emits → implement (skip test-writer)
    const judgeSends = [...judgeSource.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    expect(judgeSends.map((m) => m[1])).toContain("implement");
    expect(judgeSends.map((m) => m[1])).not.toContain("test");
  });
});

// ── AC-6 (compile): TypeScript compiles cleanly ──────────────────────────────
// This criterion is verified by `bunx tsc --noEmit` in the harness.
// The fact that this file imports all chain modules without error is itself
// a partial compile-time check.
describe("AC-6b: TypeScript compiles cleanly (partial check)", () => {
  test("all chain modules can be imported without error", async () => {
    const plan = await import("./plan.ts");
    const testWriter = await import("./test-writer.ts");
    const implement = await import("./implement.ts");
    const review = await import("./review.ts");
    const judge = await import("./judge.ts");

    expect(plan.agentLoopPlan).toBeDefined();
    expect(testWriter.agentLoopTestWriter).toBeDefined();
    expect(implement.agentLoopImplement).toBeDefined();
    expect(review.agentLoopReview).toBeDefined();
    expect(judge.agentLoopJudge).toBeDefined();
  });
});
