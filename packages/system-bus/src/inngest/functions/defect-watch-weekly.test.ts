import { describe, expect, mock, test } from "bun:test";
import {
  createDefectWatchWeeklyFunction,
  type DefectWatchDependencies,
  defectWatchSince,
} from "./defect-watch-weekly";

const NOW = new Date("2026-10-26T14:00:03Z");
const clean = {
  since: "2026-10-17T23:24:46Z",
  fix: "88470fd",
  conversations: { taper: 4 },
  by_day: { "2026-10-17": { taper: 4 } },
  regressions: [],
  total: 4,
  by_day_sum: 4,
  note: "UTC days; first and last day are partial; a conversation counts once per class",
};

function setup(over: Partial<DefectWatchDependencies> = {}) {
  const notify = mock(async (_input: unknown) => undefined);
  const emit = mock(async (_event: unknown) => ({}) as never);
  const exec = mock(async (_path: string, _since: string) => ({ stdout: JSON.stringify(clean) }));
  const deps = {
    scriptPath: () => "/fixture/defect_watch.py",
    now: () => NOW,
    exec,
    notify,
    emit,
    ...over,
  } as DefectWatchDependencies;
  const handler = (
    createDefectWatchWeeklyFunction(deps) as unknown as { fn: (ctx: unknown) => Promise<unknown> }
  ).fn;
  const ctx = { step: { run: async (_id: string, fn: () => Promise<unknown>) => fn() } };
  return { handler, ctx, notify, emit, exec };
}

describe("defect-watch-weekly", () => {
  test("since is seven days ago, floored at the fix time", () => {
    expect(defectWatchSince(NOW)).toBe("2026-10-19T14:00:03Z");
    expect(defectWatchSince(new Date("2026-10-20T00:00:00Z"))).toBe("2026-10-17T23:24:46Z");
  });

  test("zero regressions sends a quiet note to muster/desk with a cc", async () => {
    const { handler, ctx, notify, exec } = setup();
    await expect(handler(ctx)).resolves.toMatchObject({
      status: "quiet",
      regressions: 0,
      total: 4,
    });
    expect(exec).toHaveBeenCalledWith("/fixture/defect_watch.py", "2026-10-19T14:00:03Z");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      to: "muster/desk",
      cc: ["switchboard/ea"],
      source: "defect-watch-weekly",
      summary:
        "defect watch week of 2026-10-26: 0 regressions, 4 stale-tool conversations (taper 4, marked 0, regression 0)",
      quiet: true,
    });
    expect(JSON.parse((notify.mock.calls[0]?.[0] as { message: string }).message)).toEqual(clean);
  });

  test("a regression wakes the desk", async () => {
    const report = {
      ...clean,
      regressions: [{ id: "c1" }],
      conversations: { taper: 3, regression: 1 },
    };
    const { handler, ctx, notify } = setup({
      exec: async () => ({ stdout: JSON.stringify(report) }),
    });
    await expect(handler(ctx)).resolves.toMatchObject({ status: "regressions", regressions: 1 });
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      to: "muster/desk",
      quiet: false,
      summary: expect.stringContaining("1 regressions"),
    });
  });

  test("non-zero exit alarms switchboard and throws", async () => {
    const err = Object.assign(new Error("failed"), { code: 2, stderr: "boom: bad flag\n" });
    const { handler, ctx, notify, emit } = setup({
      exec: async () => {
        throw err;
      },
    });
    await expect(handler(ctx)).rejects.toThrow("defect-watch-weekly failed: exit 2");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      to: "switchboard/ea",
      summary: "defect-watch-weekly failed: exit 2",
      message: expect.stringContaining("boom: bad flag"),
    });
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      action: "defect.watch.weekly",
      success: false,
    });
  });

  test("bad JSON and wrong shape alarm", async () => {
    for (const stdout of ["not json", JSON.stringify({ regressions: "x", total: 1 })]) {
      const { handler, ctx, notify } = setup({ exec: async () => ({ stdout }) });
      await expect(handler(ctx)).rejects.toThrow("bad output");
      expect(notify.mock.calls[0]?.[0]).toMatchObject({ to: "switchboard/ea" });
    }
  });

  test("missing env alarms without running the script", async () => {
    const { handler, ctx, notify, exec } = setup({ scriptPath: () => undefined });
    await expect(handler(ctx)).rejects.toThrow("DEFECT_WATCH_SCRIPT is not set");
    expect(exec).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ to: "switchboard/ea" });
  });
});
