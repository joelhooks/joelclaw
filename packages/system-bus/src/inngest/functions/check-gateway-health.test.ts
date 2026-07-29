import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __checkGatewayHealthTestUtils } from "./check-gateway-health";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("check/gateway-health operator action", () => {
  test("requests operator action only after the existing streak threshold", () => {
    const shouldRequest = __checkGatewayHealthTestUtils.shouldRequestOperatorAction;

    expect(shouldRequest({
      generalFailure: true,
      generalStreak: 1,
      alertSuppressed: false,
      threshold: 2,
    })).toBe(false);
    expect(shouldRequest({
      generalFailure: true,
      generalStreak: 2,
      alertSuppressed: false,
      threshold: 2,
    })).toBe(true);
    expect(shouldRequest({
      generalFailure: true,
      generalStreak: 3,
      alertSuppressed: true,
      threshold: 2,
    })).toBe(false);
  });

  test("writes an idempotent local receipt with automatic restart disabled", async () => {
    const receiptDir = await mkdtemp(join(tmpdir(), "gateway-health-receipt-"));
    temporaryDirectories.push(receiptDir);
    const receipt = __checkGatewayHealthTestUtils.buildOperatorActionReceipt({
      sourceEventId: "event/with unsafe chars",
      observedAt: "2026-07-29T20:00:00.000Z",
      generalStreak: 2,
      diagnoseSummary: "process layer failed",
      criticalFailures: [
        {
          layer: "process",
          status: "failed",
          detail: "daemon is not running",
        },
      ],
    });

    const firstPath = await __checkGatewayHealthTestUtils.writeOperatorActionReceipt(
      receipt,
      receiptDir,
    );
    const secondPath = await __checkGatewayHealthTestUtils.writeOperatorActionReceipt(
      receipt,
      receiptDir,
    );
    const stored = JSON.parse(await readFile(firstPath, "utf8"));

    expect(firstPath).toBe(secondPath);
    expect(firstPath).toBe(join(receiptDir, "event_with_unsafe_chars.json"));
    expect(stored).toEqual(receipt);
    expect(stored.automaticRestart).toBe(false);
  });

  test("the checker source contains no gateway restart invocation", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "check-gateway-health.ts"),
    ).text();

    expect(source).not.toContain("[\"gateway\", \"restart\"]");
    expect(source).not.toContain("maybe-auto-restart-gateway");
    expect(source).not.toContain("gateway.health.self-healed");
  });
});
