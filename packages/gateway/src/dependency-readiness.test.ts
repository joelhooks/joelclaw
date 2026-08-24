import { describe, expect, test } from "bun:test";
import { waitForDependencyReadiness } from "./dependency-readiness";

describe("dependency readiness", () => {
  test("does not initialize channel ownership until the dependency recovers", async () => {
    let dependencyReady = false;
    let releaseRetry!: () => void;
    let ownerStarts = 0;
    const retryBarrier = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });

    const startup = (async () => {
      await waitForDependencyReadiness({
        probe: async () => {
          if (!dependencyReady) throw new Error("dependency unavailable");
        },
        wait: () => retryBarrier,
      });
      ownerStarts += 1;
    })();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ownerStarts).toBe(0);

    dependencyReady = true;
    releaseRetry();
    await startup;
    expect(ownerStarts).toBe(1);
  });

  test("waits in one process until the dependency recovers", async () => {
    let probes = 0;
    const waits: number[] = [];
    const failures: number[] = [];

    const result = await waitForDependencyReadiness({
      probe: async () => {
        probes += 1;
        if (probes < 4) throw new Error("dependency unavailable");
      },
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 20,
      onFailure: ({ attempt }) => {
        failures.push(attempt);
      },
    });

    expect(result).toEqual({ attempts: 3 });
    expect(probes).toBe(4);
    expect(waits).toEqual([10, 20, 20]);
    expect(failures).toEqual([1, 2, 3]);
  });
});
