import { describe, expect, test } from "bun:test";

import {
  MORNING_DIGEST_MARKER,
  nextMorningDigestAt,
  scheduleMorningDigest,
} from "../src/morning-digest-schedule";

describe("morning digest clock", () => {
  test("uses today's 07:30 when Los Angeles has not reached it", () => {
    expect(nextMorningDigestAt(new Date("2026-07-29T13:00:00.000Z")).toISOString())
      .toBe("2026-07-29T14:30:00.000Z");
  });

  test("uses tomorrow's 07:30 after the local threshold", () => {
    expect(nextMorningDigestAt(new Date("2026-07-29T15:00:00.000Z")).toISOString())
      .toBe("2026-07-30T14:30:00.000Z");
  });

  test("follows the Los Angeles winter offset", () => {
    expect(nextMorningDigestAt(new Date("2026-01-15T16:00:00.000Z")).toISOString())
      .toBe("2026-01-16T15:30:00.000Z");
  });
});

describe("morning digest schedule arm", () => {
  test("registers one gateway WAKE and verifies registry readback", async () => {
    const commands: string[][] = [];
    let listCalls = 0;
    const result = await scheduleMorningDigest(async (argv) => {
      commands.push(argv);
      if (argv.includes("list")) {
        listCalls += 1;
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { schedules: listCalls === 1 ? [] : [{ scheduleId: "digest-1" }] },
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          ok: true,
          result: { schedule: { scheduleId: "digest-1" } },
        }),
        stderr: "",
      };
    }, new Date("2026-07-29T15:00:00.000Z"));

    expect(result).toEqual({
      scheduleId: "digest-1",
      at: "2026-07-30T14:30:00.000Z",
      target: "gateway",
    });
    expect(commands[1]).toEqual([
      "joelclaw",
      "wake",
      "at",
      "2026-07-30T14:30:00.000Z",
      "--verb",
      "wake",
      "--target",
      "gateway",
      "--prompt",
      expect.stringContaining(MORNING_DIGEST_MARKER),
      "--format",
      "json",
    ]);
    expect(commands[2]).toEqual(["joelclaw", "wake", "list", "--format", "json"]);
  });

  test("returns an existing future marked schedule without a duplicate", async () => {
    const commands: string[][] = [];
    const result = await scheduleMorningDigest(async (argv) => {
      commands.push(argv);
      return {
        stdout: JSON.stringify({
          ok: true,
          result: {
            schedules: [{
              scheduleId: "digest-existing",
              verb: "wake",
              target: "gateway",
              at: "2026-07-30T14:30:00.000Z",
              prompt: `${MORNING_DIGEST_MARKER} already armed`,
            }],
          },
        }),
        stderr: "",
      };
    }, new Date("2026-07-29T15:00:00.000Z"));

    expect(result.scheduleId).toBe("digest-existing");
    expect(commands).toHaveLength(1);
  });

  test("does not mistake the current due schedule for its successor", async () => {
    const commands: string[][] = [];
    let listCalls = 0;
    const result = await scheduleMorningDigest(async (argv) => {
      commands.push(argv);
      if (argv.includes("list")) {
        listCalls += 1;
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              schedules: listCalls === 1
                ? [{
                    scheduleId: "digest-due",
                    verb: "wake",
                    target: "gateway",
                    at: "2026-07-29T14:30:00.000Z",
                    prompt: `${MORNING_DIGEST_MARKER} due now`,
                  }]
                : [{ scheduleId: "digest-next" }],
            },
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({ ok: true, result: { scheduleId: "digest-next" } }),
        stderr: "",
      };
    }, new Date("2026-07-29T14:31:00.000Z"));

    expect(result).toMatchObject({ scheduleId: "digest-next" });
    expect(commands[1]).toContain("2026-07-30T14:30:00.000Z");
  });

  test("cancels a new schedule when registry readback cannot prove it", async () => {
    const commands: string[][] = [];
    await expect(scheduleMorningDigest(async (argv) => {
      commands.push(argv);
      if (argv.includes("list")) {
        return { stdout: JSON.stringify({ ok: true, result: { schedules: [] } }), stderr: "" };
      }
      if (argv.includes("cancel")) {
        return {
          stdout: JSON.stringify({ ok: true, result: { scheduleId: "digest-1" } }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({ ok: true, result: { scheduleId: "digest-1" } }),
        stderr: "",
      };
    }, new Date("2026-07-29T15:00:00.000Z"))).rejects.toThrow("readback did not contain");

    expect(commands.at(-2)).toEqual([
      "joelclaw",
      "wake",
      "cancel",
      "digest-1",
      "--format",
      "json",
    ]);
    expect(commands.at(-1)).toEqual(["joelclaw", "wake", "list", "--format", "json"]);
  });
});
