import { describe, expect, test } from "bun:test";

describe("AC-1: formatLoopDuration is exported from utils.ts", () => {
  test("formatLoopDuration is a named export", async () => {
    const utils = await import("./utils.ts");
    expect(utils.formatLoopDuration).toBeDefined();
    expect(typeof utils.formatLoopDuration).toBe("function");
  });
});

import { formatLoopDuration } from "./utils.ts";

describe("formatLoopDuration", () => {
  test("returns 0s for zero", () => {
    expect(formatLoopDuration(0)).toBe("0s");
  });

  test("returns 0s for negative values", () => {
    expect(formatLoopDuration(-100)).toBe("0s");
  });

  test("formats sub-second values with one decimal place", () => {
    expect(formatLoopDuration(500)).toBe("0.5s");
  });

  test("formats exact seconds without higher units", () => {
    expect(formatLoopDuration(5000)).toBe("5s");
  });

  test("formats minutes and seconds", () => {
    expect(formatLoopDuration(65000)).toBe("1m 5s");
  });

  test("formats hours, minutes, and seconds", () => {
    expect(formatLoopDuration(3661000)).toBe("1h 1m 1s");
  });

  test("omits zero-value tail segments", () => {
    expect(formatLoopDuration(3600000)).toBe("1h");
    expect(formatLoopDuration(3660000)).toBe("1h 1m");
  });

  test("omits zero-value segments (no 0m / 0s padding)", () => {
    expect(formatLoopDuration(7200000)).toBe("2h");
    expect(formatLoopDuration(120000)).toBe("2m");
  });

  test("drops sub-second remainder once duration is at least 1 second", () => {
    expect(formatLoopDuration(65300)).toBe("1m 5s");
    expect(formatLoopDuration(1250)).toBe("1s");
  });

  test("formats very large values", () => {
    expect(formatLoopDuration(86400000)).toBe("24h");
  });

  test("rounds down tiny sub-second values", () => {
    expect(formatLoopDuration(1)).toBe("0s");
  });

  test("rounds sub-second values to nearest tenth", () => {
    expect(formatLoopDuration(999)).toBe("1s");
  });
});
