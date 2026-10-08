import { describe, expect, test } from "bun:test";
import { createDependencyFailureLatch } from "./dependency-latch";

describe("dependency failure latch", () => {
  test("opens once, holds through its cooldown, and closes at the deadline", () => {
    let now = 1_000;
    const latch = createDependencyFailureLatch({ cooldownMs: 500, now: () => now });

    expect(latch.read()).toEqual({ _tag: "Closed" });
    const opened = latch.trip("connection refused");
    expect(opened).toEqual({ _tag: "Open", retryAtMs: 1_500, reason: "connection refused" });
    expect(latch.trip("second failure")).toEqual(opened);

    now = 1_499;
    expect(latch.read()).toEqual(opened);
    now = 1_500;
    expect(latch.read()).toEqual({ _tag: "Closed" });
  });

  test("reset closes an open latch immediately", () => {
    const latch = createDependencyFailureLatch({ cooldownMs: 500, now: () => 1_000 });
    latch.trip("dependency down");

    latch.reset();

    expect(latch.read()).toEqual({ _tag: "Closed" });
  });
});
