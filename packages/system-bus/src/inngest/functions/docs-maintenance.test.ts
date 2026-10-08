import { describe, expect, test } from "bun:test";
import { NonRetriableError } from "inngest";
import {
  classifyFinalizationFailure,
  createDocsManifestDependencyGuard,
  shouldDispatchBacklogDriver,
  shouldRequeueAfterCancelAttempt,
} from "./docs-maintenance";

describe("docs-maintenance helpers", () => {
  test("latches a missing manifest and probes again after cooldown", async () => {
    let now = 1_000;
    let attempts = 0;
    let available = false;
    const guard = createDocsManifestDependencyGuard({
      cooldownMs: 500,
      now: () => now,
      resolve: async () => {
        attempts += 1;
        if (!available) throw new NonRetriableError("Manifest file not found");
        return "/fixture/manifest.clean.jsonl";
      },
    });

    await expect(guard.resolve(undefined)).rejects.toBeInstanceOf(NonRetriableError);
    expect(guard.read()).toMatchObject({ _tag: "Open", retryAtMs: 1_500 });
    await expect(guard.resolve(undefined)).rejects.toThrow("latched");
    expect(guard.shouldSkipDriver()).toBe(true);
    expect(attempts).toBe(1);

    now = 1_500;
    available = true;
    await expect(guard.resolve(undefined)).resolves.toBe("/fixture/manifest.clean.jsonl");
    expect(guard.read()).toEqual({ _tag: "Closed" });
    expect(guard.shouldSkipDriver()).toBe(false);
    expect(attempts).toBe(2);
  });

  test("backlog driver dispatches when queue depth is below gates", () => {
    const allowed = shouldDispatchBacklogDriver({
      docsRunning: 1,
      docsQueued: 6,
      maxRunning: 2,
      maxQueued: 8,
    });

    expect(allowed).toBe(true);
  });

  test("backlog driver blocks when running or queued reaches threshold", () => {
    const blockedByRunning = shouldDispatchBacklogDriver({
      docsRunning: 2,
      docsQueued: 1,
      maxRunning: 2,
      maxQueued: 8,
    });
    const blockedByQueued = shouldDispatchBacklogDriver({
      docsRunning: 1,
      docsQueued: 8,
      maxRunning: 2,
      maxQueued: 8,
    });

    expect(blockedByRunning).toBe(false);
    expect(blockedByQueued).toBe(false);
  });

  test("backlog driver force flag bypasses queue gates", () => {
    const forced = shouldDispatchBacklogDriver({
      docsRunning: 10,
      docsQueued: 100,
      maxRunning: 0,
      maxQueued: 0,
      force: true,
    });

    expect(forced).toBe(true);
  });

  test("finalization failure classification maps known signatures", () => {
    expect(classifyFinalizationFailure("Unable to reach SDK URL during finalization")).toBe(
      "sdk_unreachable"
    );
    expect(classifyFinalizationFailure("error inserting trace run: context canceled")).toBe(
      "context_canceled"
    );
    expect(classifyFinalizationFailure("something else exploded")).toBe(
      "finalization_failed_other"
    );
  });

  test("requeue requires a successful cancel status", () => {
    expect(
      shouldRequeueAfterCancelAttempt({
        cancelStatus: "CANCELLED",
      })
    ).toBe(true);
    expect(
      shouldRequeueAfterCancelAttempt({
        cancelStatus: "RUNNING",
      })
    ).toBe(false);
    expect(
      shouldRequeueAfterCancelAttempt({
        cancelStatus: null,
      })
    ).toBe(false);
  });

  test("requeue is blocked when cancel call errors", () => {
    expect(
      shouldRequeueAfterCancelAttempt({
        cancelStatus: "CANCELLED",
        cancelError: "not found",
      })
    ).toBe(false);
  });
});
