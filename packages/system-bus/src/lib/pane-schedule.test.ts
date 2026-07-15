import { describe, expect, test } from "bun:test";
import {
  isPaneScheduleLate,
  PaneScheduleValidationError,
  validatePaneSchedule,
} from "./pane-schedule";

const base = {
  version: 1,
  scheduleId: "sched-1",
  verb: "wake",
  at: "2026-07-14T18:30:00.000Z",
  target: "pi-worker",
  requestedBy: "test",
  createdAt: "2026-07-14T18:00:00.000Z",
};

describe("pane schedule contract", () => {
  test("accepts a valid wake entry", () => {
    expect(validatePaneSchedule(base)).toEqual(base);
  });

  test("teaches verb-specific required fields", () => {
    expect(() => validatePaneSchedule({ ...base, verb: "spawn", target: undefined })).toThrow(
      "spawn requires briefPath (--brief)",
    );
    expect(() => validatePaneSchedule({ ...base, verb: "revive", target: undefined })).toThrow(
      "revive requires loopId (--loop)",
    );
  });

  test("rejects fields that belong to another verb", () => {
    try {
      validatePaneSchedule({ ...base, verb: "spawn", briefPath: "/tmp/x.svx" });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PaneScheduleValidationError);
      expect(String(error)).toContain("target is only valid with verb wake");
    }
  });

  test("marks only fires more than five minutes late", () => {
    const at = "2026-07-14T18:30:00.000Z";
    expect(isPaneScheduleLate(at, Date.parse(at) + 5 * 60_000)).toBe(false);
    expect(isPaneScheduleLate(at, Date.parse(at) + 5 * 60_000 + 1)).toBe(true);
  });
});
