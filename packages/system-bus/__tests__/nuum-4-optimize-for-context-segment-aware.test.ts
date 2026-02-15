import { describe, expect, test } from "bun:test";

async function loadObserveParserModule() {
  return import("../src/inngest/functions/observe-parser.ts");
}

describe("NUUM-4: optimizeForContext segment-aware format", () => {
  test("AC-1: segment-aware input keeps all narratives and only 🔴 facts", async () => {
    const { optimizeForContext } = await loadObserveParserModule();

    const observations = `
<segment>
  <narrative>Pipeline fell behind after a burst of events.</narrative>
  <facts>
    - 🔴 Backlog reached 12,000 messages
    - 🟡 Worker CPU trended up
  </facts>
</segment>
<segment>
  <narrative>Throughput recovered after autoscaling.</narrative>
  <facts>
    - 🔴 Queue depth normalized within 4 minutes
    - 🟢 Dashboard annotation updated
  </facts>
</segment>
`.trim();

    const result = optimizeForContext(observations);

    expect(result).toContain("Pipeline fell behind after a burst of events.");
    expect(result).toContain("Throughput recovered after autoscaling.");
    expect(result).toContain("🔴 Backlog reached 12,000 messages");
    expect(result).toContain("🔴 Queue depth normalized within 4 minutes");
  });

  test("AC-2: segment-aware input drops 🟡 and 🟢 facts", async () => {
    const { optimizeForContext } = await loadObserveParserModule();

    const observations = `
<segment>
  <narrative>Retries increased during rollout.</narrative>
  <facts>
    - 🔴 Primary queue stalled
    - 🟡 Retry latency increased
    - 🟢 Logging format improved
  </facts>
</segment>
`.trim();

    const result = optimizeForContext(observations);

    expect(result).toContain("Retries increased during rollout.");
    expect(result).toContain("🔴 Primary queue stalled");
    expect(result).not.toContain("🟡 Retry latency increased");
    expect(result).not.toContain("🟢 Logging format improved");
  });

  test("AC-3: flat-format input remains backward compatible", async () => {
    const { optimizeForContext } = await loadObserveParserModule();

    const observations = [
      "Date: 2026-02-14",
      "🔴 Correct npm script is bun test",
      "regular unmarked note should be removed",
      "Some context with 🔴 marker in the middle",
      "🟡 Pattern: repeated retries before timeout",
      "🟢 Minor: adjusted spacing in logs",
      "Date: 2026-02-15",
      "  🔴 Another critical item with leading whitespace",
    ].join("\n");

    expect(optimizeForContext(observations)).toBe(
      [
        "Date: 2026-02-14",
        "🔴 Correct npm script is bun test",
        "Some context with 🔴 marker in the middle",
        "Date: 2026-02-15",
        "  🔴 Another critical item with leading whitespace",
      ].join("\n")
    );
  });
});

describe("NUUM-4: TypeScript compile gate", () => {
  test(
    "AC-4: bunx tsc --noEmit succeeds",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: new URL("..", import.meta.url).pathname,
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    },
    30_000
  );
});
