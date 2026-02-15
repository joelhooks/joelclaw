import { describe, expect, test } from "bun:test";
import { formatLoopDuration } from "./utils.ts";

describe("DUR-1: formatLoopDuration acceptance tests", () => {
  test("AC-1: utils.ts exports named function formatLoopDuration", async () => {
    const utils = await import("./utils.ts");
    expect(utils.formatLoopDuration).toBeDefined();
    expect(typeof utils.formatLoopDuration).toBe("function");
  });

  test("AC-2: formatLoopDuration(0) returns '0s'", () => {
    expect(formatLoopDuration(0)).toBe("0s");
  });

  test("AC-3: negative values return '0s'", () => {
    expect(formatLoopDuration(-100)).toBe("0s");
    expect(formatLoopDuration(-1)).toBe("0s");
  });

  test("AC-4: sub-second values are formatted in seconds", () => {
    expect(formatLoopDuration(500)).toBe("0.5s");
  });

  test("AC-5: exact seconds are formatted without decimal", () => {
    expect(formatLoopDuration(5000)).toBe("5s");
  });

  test("AC-6: minutes and seconds are formatted", () => {
    expect(formatLoopDuration(65000)).toBe("1m 5s");
  });

  test("AC-7: hours, minutes, and seconds are formatted", () => {
    expect(formatLoopDuration(3661000)).toBe("1h 1m 1s");
  });

  test("AC-8: one second boundary formats as '1s'", () => {
    expect(formatLoopDuration(1000)).toBe("1s");
  });

  test("AC-9: one minute boundary formats as '1m 0s'", () => {
    expect(formatLoopDuration(60000)).toBe("1m 0s");
  });

  test("AC-10: one hour boundary formats as '1h 0m 0s'", () => {
    expect(formatLoopDuration(3600000)).toBe("1h 0m 0s");
  });

  test("AC-11: function behaves as pure (deterministic, no observable side effects)", () => {
    const inputs = [-10, 0, 1, 500, 999, 1000, 65000, 3661000];
    const firstPass = inputs.map((ms) => formatLoopDuration(ms));
    const secondPass = inputs.map((ms) => formatLoopDuration(ms));
    expect(secondPass).toEqual(firstPass);

    const snapshot = {
      tz: process.env.TZ,
      pid: process.pid,
      nowType: typeof Date.now,
    };
    void formatLoopDuration(12345);
    expect(process.env.TZ).toBe(snapshot.tz);
    expect(process.pid).toBe(snapshot.pid);
    expect(typeof Date.now).toBe(snapshot.nowType);
  });

  test("AC-12: TypeScript typing is compatible with (ms: number) => string", () => {
    const typed: (ms: number) => string = formatLoopDuration;
    expect(typed(500)).toBe("0.5s");
  });
});
