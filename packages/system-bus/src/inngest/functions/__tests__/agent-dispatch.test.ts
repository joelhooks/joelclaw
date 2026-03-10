import { describe, expect, test } from "bun:test";

import { __testables } from "../agent-dispatch";

describe("agent-dispatch subprocess capture", () => {
  test("returns after parent exit even when a background child keeps stderr open", async () => {
    const startedAt = Date.now();
    const result = await __testables.runAgentCommand(
      "bash -lc '(sleep 2; echo orphan-stderr >&2) & echo parent-stderr >&2; exit 7'",
      {
        cwd: process.cwd(),
        timeoutSeconds: 5,
        env: process.env,
        requestId: "agent-dispatch-test-parent-exit",
      },
    );
    const durationMs = Date.now() - startedAt;

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("parent-stderr");
    expect(durationMs).toBeLessThan(1500);
  });

  test("surfaces timeout explicitly instead of hanging forever", async () => {
    const startedAt = Date.now();
    const result = await __testables.runAgentCommand("sleep 5", {
      cwd: process.cwd(),
      timeoutSeconds: 1,
      env: process.env,
      requestId: "agent-dispatch-test-timeout",
    });
    const durationMs = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(durationMs).toBeLessThan(2500);
  });
});
