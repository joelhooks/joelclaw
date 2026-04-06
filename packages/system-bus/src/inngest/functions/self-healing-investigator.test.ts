import { describe, expect, test } from "bun:test";

const { __selfHealingInvestigatorTestUtils } = await import("./self-healing-investigator");
const { isAbortLikeError, resolveFailedRunsQueryTimeoutMs } = __selfHealingInvestigatorTestUtils;

describe("self-healing investigator failed-run query budgeting", () => {
  test("treats AbortError-style failures as retryable", () => {
    expect(isAbortLikeError(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true);
    expect(isAbortLikeError(new Error("The operation was aborted."))).toBe(true);
    expect(isAbortLikeError(new Error("boom"))).toBe(false);
  });

  test("uses a longer timeout budget as failed-run scans widen", () => {
    expect(resolveFailedRunsQueryTimeoutMs(10)).toBeGreaterThanOrEqual(30000);
    expect(resolveFailedRunsQueryTimeoutMs(80)).toBeGreaterThanOrEqual(resolveFailedRunsQueryTimeoutMs(40));
  });
});
