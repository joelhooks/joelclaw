import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as notification from "../../lib/notify-agent";
import * as joel from "../../lib/notify-joel";
import * as telemetry from "../../observability/emit";
import { __wikiEditionBuildTestUtils, wikiEditionBuild } from "./wiki-edition-build";

const {
  blockedSourceRuns,
  buildNotification,
  parseEditionBuild,
  buildEditionFailure,
  buildStaticFailure,
} = __wikiEditionBuildTestUtils;
afterEach(() => mock.restore());

describe("wiki edition build", () => {
  test("parses edition state and blocked source runs", () => {
    const result = parseEditionBuild(
      JSON.stringify({
        state: {
          editionId: "2026-07-15",
          written: 4,
          loopCount: 3,
          observationCount: 12,
          sourceRuns: [{ status: "complete" }, { status: "blocked", id: "run-2" }],
        },
      }),
    );

    expect(result.editionId).toBe("2026-07-15");
    expect(blockedSourceRuns(result.sourceRuns)).toEqual([{ status: "blocked", id: "run-2" }]);
  });

  test("rejects invalid JSON instead of reporting a successful build", () => {
    expect(() => parseEditionBuild("not json")).toThrow();
  });

  for (const state of ["failed", "cancelled"]) {
    test(`preserves ${state} stdout state, error and source kinds without observations`, () => {
      const result = buildEditionFailure({
        stdout: JSON.stringify({
          state,
          error: "fixture error",
          sourceRuns: [
            { kind: "mail", status: "failed", observations: "private-fixture-content" },
            { kind: "notes", status: "blocked" },
            { kind: "feed", status: "complete" },
          ],
        }),
      });
      expect(result).toEqual({
        ok: false,
        phase: "build-edition",
        state,
        error: `${state}: fixture error`,
        sourceRuns: [
          { kind: "mail", status: "failed" },
          { kind: "notes", status: "blocked" },
        ],
      });
      const text = buildNotification({ buildEdition: result, blockedCount: 1 });
      expect(text).toContain(`${state}: fixture error`);
      expect(text).toContain("failed: mail, blocked: notes");
      expect(text).not.toContain("private-fixture-content");
    });
  }

  test("failed stdout with empty error remains a useful failure", () => {
    expect(
      buildEditionFailure({ stdout: JSON.stringify({ state: "failed", error: "" }) }),
    ).toMatchObject({ ok: false, state: "failed", error: "failed: no error text" });
  });

  test("exists on non-zero exit remains success", () => {
    expect(
      buildEditionFailure({
        stdout: JSON.stringify({ state: "exists", editionId: "fixture-edition" }),
      }),
    ).toMatchObject({ ok: true, state: "exists", editionId: "fixture-edition" });
  });

  test("static failure includes only the last 600 stderr characters", () => {
    const result = buildStaticFailure(
      Object.assign(new Error("Command failed"), {
        stderr: `${"x".repeat(700)}vite adapter failed`,
      }),
    );
    expect(result).toMatchObject({ ok: false, phase: "build-static" });
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toEndWith(`${"x".repeat(581)}vite adapter failed`);
    expect(result.error).not.toContain("x".repeat(601));
  });

  test("failures go to Joel and the morning receipt goes to Rat King", async () => {
    const handler = (wikiEditionBuild as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn;
    const emit = spyOn(telemetry, "emitOtelEvent").mockResolvedValue({} as never);
    const notify = spyOn(notification, "notifyAgent").mockResolvedValue(undefined);
    const notifyJoel = spyOn(joel, "notifyJoel").mockResolvedValue(undefined);
    for (const failure of [true, false]) {
      const build = failure
        ? buildEditionFailure({
            stdout: JSON.stringify({
              state: "failed",
              error: "fixture error",
              sourceRuns: [{ kind: "mail", status: "blocked" }],
            }),
          })
        : parseEditionBuild(
            JSON.stringify({
              state: "built",
              editionId: "fixture-edition",
              sourceRuns: [{ kind: "mail", status: "blocked" }],
            }),
          );
      const sends: Array<[string, unknown]> = [];
      const steps: string[] = [];
      const ctx = {
        step: {
          run: async (id: string, fn: () => Promise<unknown>) => {
            steps.push(id);
            if (id === "build-edition" || id === "build-static") return build;
            if (id === "compose-morning-receipt") return "fixture morning receipt";
            return fn();
          },
          sendEvent: async (id: string, payload: unknown) => {
            sends.push([id, payload]);
          },
        },
      };
      if (failure) await expect(handler(ctx)).rejects.toThrow("failed: fixture error");
      else await expect(handler(ctx)).resolves.toMatchObject({ status: "blocked" });
      expect(notifyJoel).toHaveBeenLastCalledWith({
        kind: "needs_joel",
        source: "wiki-edition-build",
        message: expect.stringContaining("blocked source runs: 1"),
      });
      if (failure)
        expect(notifyJoel).toHaveBeenLastCalledWith(
          expect.objectContaining({
            message: expect.stringMatching(
              /failed: fixture error[\s\S]*failed: mail|blocked: mail/,
            ),
          }),
        );
      expect(steps).toContain("notify-wiki-edition-build-receipt");
      if (failure) {
        expect(sends).toEqual([]);
        expect(notify).not.toHaveBeenCalled();
        expect(emit).toHaveBeenLastCalledWith(
          expect.objectContaining({
            error: "build-edition: failed: fixture error",
            metadata: expect.objectContaining({
              buildState: "failed",
              failedSourceRunKinds: [{ status: "blocked", kind: "mail" }],
            }),
          }),
        );
      } else {
        expect(sends.map(([id]) => id)).toEqual(["wiki-edition-built"]);
        expect(steps).toContain("notify-morning-receipt");
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenLastCalledWith({
          to: "switchboard/ea",
          source: "wiki-edition-build",
          summary: "Wiki edition built",
          message: "fixture morning receipt",
        });
        notify.mockClear();
      }
      const uncertain = new notification.NotifyAgentUncertainError("uncertain", 3);
      (failure ? notifyJoel : notify).mockRejectedValueOnce(uncertain);
      await expect(handler(ctx)).rejects.toBe(uncertain);
    }
  });

  test("static failure details reach build telemetry and the Joel notice", async () => {
    const handler = (wikiEditionBuild as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn;
    const emit = spyOn(telemetry, "emitOtelEvent").mockResolvedValue({} as never);
    const notify = spyOn(joel, "notifyJoel").mockResolvedValue(undefined);
    const build = parseEditionBuild(
      JSON.stringify({ state: "built", editionId: "fixture-edition" }),
    );
    const failure = buildStaticFailure(
      Object.assign(new Error("Static build failed"), { stderr: "vite adapter fixture error" }),
    );
    await expect(
      handler({
        step: {
          run: async (id: string, fn: () => Promise<unknown>) => {
            if (id === "build-edition") return build;
            if (id === "build-static") return failure;
            return fn();
          },
          sendEvent: () => {
            throw new Error("unexpected morning send");
          },
        },
      }),
    ).rejects.toThrow("vite adapter fixture error");
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("vite adapter fixture error"),
        metadata: expect.objectContaining({
          staticError: expect.stringContaining("vite adapter fixture error"),
        }),
      }),
    );
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining("vite adapter fixture error") }),
    );
  });

  test("builds a bounded failure receipt", () => {
    expect(
      buildNotification({
        buildEdition: { ok: false, phase: "build-edition", error: "boom" },
        blockedCount: 0,
      }),
    ).toBe("wiki edition build receipt\nfailed: build-edition: boom\nblocked source runs: 0");
  });
});
