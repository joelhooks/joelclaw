import { expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { __checkSystemHealthTestUtils } from "./check-system-health";

const { runAsyncCommand } = __checkSystemHealthTestUtils;

test("bounded health-check commands leave the event loop responsive", async () => {
  let childClosed = false;
  let tickedWhileChildRunning = false;
  const ticker = setInterval(() => {
    if (!childClosed) tickedWhileChildRunning = true;
  }, 5);

  try {
    const result = await runAsyncCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 200)"],
      2_000,
    );
    childClosed = true;

    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(tickedWhileChildRunning).toBe(true);
  } finally {
    childClosed = true;
    clearInterval(ticker);
  }
});

test("bounded health-check commands kill timed-out children without blocking", async () => {
  const startedAt = performance.now();
  const result = await runAsyncCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 5_000)"],
    100,
  );

  expect(result.status).toBe(null);
  expect(result.timedOut).toBe(true);
  expect(performance.now() - startedAt).toBeLessThan(2_000);
});

test("bounded health-check commands retain nonzero exit status and output", async () => {
  const result = await runAsyncCommand(
    process.execPath,
    ["-e", "process.stdout.write('stdout'); process.stderr.write('stderr'); process.exit(7)"],
    2_000,
  );

  expect(result.status).toBe(7);
  expect(result.stdout).toBe("stdout");
  expect(result.stderr).toBe("stderr");
  expect(result.timedOut).toBe(false);
});
