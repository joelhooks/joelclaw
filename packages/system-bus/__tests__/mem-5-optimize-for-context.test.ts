import { describe, expect, test } from "bun:test";

async function loadObserveParserModule() {
  return import("../src/inngest/functions/observe-parser.ts");
}

describe("MEM-5: optimizeForContext export", () => {
  test("AC-1: src/inngest/functions/observe-parser.ts exports optimizeForContext", async () => {
    const mod = await loadObserveParserModule();

    expect("optimizeForContext" in mod).toBe(true);
    expect(typeof mod.optimizeForContext).toBe("function");
  });
});

describe("MEM-5: optimizeForContext behavior", () => {
  test("AC-2/AC-3/AC-4: keeps 🔴 and Date: lines, removes 🟡/🟢 and unrelated lines", async () => {
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

    const result = optimizeForContext(observations);

    expect(result).toBe(
      [
        "Date: 2026-02-14",
        "🔴 Correct npm script is bun test",
        "Some context with 🔴 marker in the middle",
        "Date: 2026-02-15",
        "  🔴 Another critical item with leading whitespace",
      ].join("\n")
    );
  });

  test("AC-5: returns empty string for empty input", async () => {
    const { optimizeForContext } = await loadObserveParserModule();

    expect(optimizeForContext("")).toBe("");
  });
});

describe("MEM-5: TypeScript compile gate", () => {
  test(
    "AC-6: bunx tsc --noEmit succeeds",
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
