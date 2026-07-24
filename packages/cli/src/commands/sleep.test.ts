import { describe, expect, test } from "bun:test";
import { __wakeTestUtils } from "./sleep";

const { assertChainSuccessor, makeScheduleEntry, parseScheduleDuration, resolveScheduleAt } = __wakeTestUtils;

describe("joelclaw wake scheduling", () => {
  test("parses compound in durations", () => {
    expect(parseScheduleDuration("2h")).toBe(7_200_000);
    expect(parseScheduleDuration("1d 2h 5m")).toBe(93_900_000);
    expect(parseScheduleDuration("soon")).toBeNull();
  });

  test("resolves in at request time", () => {
    expect(resolveScheduleAt("in", "5m", Date.parse("2026-07-14T18:00:00.000Z"))).toBe(
      "2026-07-14T18:05:00.000Z",
    );
  });

  test("normalizes parseable at input", () => {
    expect(resolveScheduleAt("at", "July 14 2027 18:30 UTC", Date.parse("2026-07-14T18:00:00.000Z"))).toBe(
      "2027-07-14T18:30:00.000Z",
    );
  });

  test("parses verb options into a validated entry", () => {
    const entry = makeScheduleEntry({
      mode: "in",
      when: "2h",
      verb: "spawn",
      briefPath: "/tmp/x.svx",
      prompt: "extra context",
      nowMs: Date.parse("2026-07-14T18:00:00.000Z"),
    });
    expect(entry).toMatchObject({
      version: 1,
      verb: "spawn",
      at: "2026-07-14T20:00:00.000Z",
      briefPath: "/tmp/x.svx",
      prompt: "extra context",
    });
  });

  test("campaign-pulse successor assertion requires exactly one matching future schedule", () => {
    const nowMs = Date.parse("2026-07-21T18:00:00.000Z");
    const expectedAt = "2026-07-21T19:00:00.000Z";
    const briefPath = "/repo/.brain/projects/campaign-pulse/asset-hourly-pulse-runbook.svx";
    const matching = {
      version: 1 as const,
      scheduleId: "pulse-next",
      verb: "spawn" as const,
      at: expectedAt,
      briefPath,
      requestedBy: "test",
      createdAt: "2026-07-21T17:59:00.000Z",
    };

    expect(assertChainSuccessor({ chain: "campaign-pulse", briefPath, expectedAt, schedules: [matching], nowMs })).toEqual({
      chain: "campaign-pulse",
      scheduleId: "pulse-next",
      fireTime: expectedAt,
      verified: true,
      matchingCount: 1,
    });
    expect(assertChainSuccessor({ chain: "campaign-pulse", briefPath, expectedAt, schedules: [], nowMs })).toMatchObject({ verified: false, matchingCount: 0 });
    expect(assertChainSuccessor({ chain: "campaign-pulse", briefPath, expectedAt, schedules: [matching, { ...matching, scheduleId: "pulse-duplicate" }], nowMs })).toMatchObject({ verified: false, matchingCount: 2 });
    expect(assertChainSuccessor({ chain: "campaign-pulse", briefPath, expectedAt, schedules: [{ ...matching, at: "2026-07-21T17:00:00.000Z" }], nowMs })).toMatchObject({ verified: false, matchingCount: 0 });
  });
});
