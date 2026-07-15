import { describe, expect, test } from "bun:test";
import { __wakeTestUtils } from "./sleep";

const { makeScheduleEntry, parseScheduleDuration, resolveScheduleAt } = __wakeTestUtils;

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
});
