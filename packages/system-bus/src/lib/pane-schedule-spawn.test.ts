import { describe, expect, test } from "bun:test";
import type { PaneScheduleEntry } from "./pane-schedule";
import {
  beatLaneKey,
  beatLaneLabel,
  buildSpawnLaunchCommand,
  executeSpawnBeat,
  planSpawnBeat,
  SCHEDULED_BEATS_WORKSPACE_LABEL,
  scheduledBeatLabel,
} from "./pane-schedule-spawn";

const spawnEntry: PaneScheduleEntry = {
  version: 1,
  scheduleId: "sched-spawn-1",
  verb: "spawn",
  at: "2026-07-25T18:00:00.000Z",
  briefPath: "/repo/campaign-pulse/asset-hourly-pulse-runbook.svx",
  prompt: "Run the Hourly Campaign Pulse runbook.",
  requestedBy: "test",
  createdAt: "2026-07-25T17:00:00.000Z",
};

describe("pane schedule spawn planning", () => {
  test("builds a stable beat lane label from the brief title", () => {
    expect(scheduledBeatLabel("Hourly Campaign Pulse")).toBe("⏰ Hourly Campaign Pulse");
    expect(beatLaneLabel(spawnEntry, () => "title: Campaign Pulse\n", () => true)).toBe(
      "⏰ Campaign Pulse",
    );
  });

  test("reuses an idle pane with the lane label instead of creating", () => {
    const label = "⏰ Campaign Pulse";
    const plan = planSpawnBeat({
      entry: spawnEntry,
      briefExists: true,
      label,
      panes: [
        {
          pane_id: "w9:p1",
          label,
          agent_status: "idle",
          workspace_id: "w9",
        },
      ],
      agents: [{ pane_id: "w9:p1", agent_status: "idle" }],
    });
    expect(plan).toMatchObject({
      action: "reuse",
      paneId: "w9:p1",
      mode: "prompt",
      label,
    });
  });

  test("reuses a done pane on the second firing", () => {
    const label = "⏰ Campaign Pulse";
    const plan = planSpawnBeat({
      entry: spawnEntry,
      briefExists: true,
      label,
      panes: [{ pane_id: "w9:p1", label, agent_status: "done", workspace_id: "w9" }],
      agents: [{ pane_id: "w9:p1", agent_status: "done" }],
    });
    expect(plan).toMatchObject({ action: "reuse", paneId: "w9:p1", mode: "prompt" });
  });

  test("does not create a second pane while the beat lane is working", () => {
    const label = "⏰ Campaign Pulse";
    const plan = planSpawnBeat({
      entry: spawnEntry,
      briefExists: true,
      label,
      panes: [{ pane_id: "w9:p1", label, agent_status: "working", workspace_id: "w9" }],
      agents: [{ pane_id: "w9:p1", agent_status: "working" }],
    });
    expect(plan).toEqual({
      action: "busy",
      paneId: "w9:p1",
      label,
      agentStatus: "working",
    });
  });

  test("ignores matching labels inside the gateway loop's own workspace", () => {
    const label = "⏰ Campaign Pulse";
    const plan = planSpawnBeat({
      entry: spawnEntry,
      briefExists: true,
      label,
      panes: [
        // The gateway loop is what makes this workspace off-limits — no
        // hardcoded id, so the guard survives a herdr restart.
        { pane_id: "wG:p1", label: "📨 gateway loop", agent_status: "idle", workspace_id: "wG" },
        { pane_id: "wG:p9", label, agent_status: "idle", workspace_id: "wG" },
      ],
      workspaces: [],
    });
    expect(plan).toMatchObject({
      action: "create",
      label,
      createWorkspace: true,
    });
  });

  test("creates in the scheduled beats workspace when no lane pane exists", () => {
    const label = "⏰ Campaign Pulse";
    const plan = planSpawnBeat({
      entry: spawnEntry,
      briefExists: true,
      label,
      panes: [],
      workspaces: [{ workspace_id: "wBeats", label: SCHEDULED_BEATS_WORKSPACE_LABEL }],
    });
    expect(plan).toEqual({
      action: "create",
      label,
      workspaceId: "wBeats",
      createWorkspace: false,
      launch: buildSpawnLaunchCommand(spawnEntry),
    });
  });

  test("refuses a missing brief instead of spawning", () => {
    expect(
      planSpawnBeat({
        entry: spawnEntry,
        briefExists: false,
        panes: [],
      }),
    ).toEqual({
      action: "refuse",
      reason: "briefPath missing: /repo/campaign-pulse/asset-hourly-pulse-runbook.svx",
    });
  });
});

describe("executeSpawnBeat", () => {
  test("reuses an existing idle lane pane and does not create a tab", async () => {
    const calls: string[][] = [];
    const label = "⏰ Campaign Pulse";
    const result = await executeSpawnBeat(spawnEntry, {
      briefExists: () => true,
      readBriefTitle: () => "Campaign Pulse",
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv.join(" ") === "herdr pane list") {
          return {
            stdout: JSON.stringify({
              result: {
                panes: [{ pane_id: "w9:p1", label, agent_status: "idle", workspace_id: "w9" }],
              },
            }),
            stderr: "",
          };
        }
        if (argv.join(" ") === "herdr agent list") {
          return {
            stdout: JSON.stringify({
              result: { agents: [{ pane_id: "w9:p1", agent_status: "idle" }] },
            }),
            stderr: "",
          };
        }
        if (argv.join(" ") === "herdr workspace list") {
          return {
            stdout: JSON.stringify({
              result: {
                workspaces: [{ workspace_id: "wBeats", label: SCHEDULED_BEATS_WORKSPACE_LABEL }],
              },
            }),
            stderr: "",
          };
        }
        return { stdout: "{}", stderr: "" };
      },
    });

    expect(result).toEqual({
      status: "reused",
      scheduleId: "sched-spawn-1",
      paneId: "w9:p1",
      label,
      created: false,
      ack: true,
    });
    expect(calls.some((argv) => argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")).toBe(
      false,
    );
    expect(
      calls.some(
        (argv) =>
          argv[0] === "herdr" &&
          argv[1] === "agent" &&
          argv[2] === "prompt" &&
          argv[3] === "w9:p1",
      ),
    ).toBe(true);
  });

  test("creates one pane in the beats workspace when the lane is missing", async () => {
    const calls: string[][] = [];
    const label = "⏰ Campaign Pulse";
    const result = await executeSpawnBeat(spawnEntry, {
      briefExists: () => true,
      readBriefTitle: () => "Campaign Pulse",
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv.join(" ") === "herdr pane list") {
          return { stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
        }
        if (argv.join(" ") === "herdr agent list") {
          return { stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" };
        }
        if (argv.join(" ") === "herdr workspace list") {
          return {
            stdout: JSON.stringify({
              result: {
                workspaces: [{ workspace_id: "wBeats", label: SCHEDULED_BEATS_WORKSPACE_LABEL }],
              },
            }),
            stderr: "",
          };
        }
        if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
          return {
            stdout: JSON.stringify({
              result: { root_pane: { pane_id: "wBeats:p2", workspace_id: "wBeats" } },
            }),
            stderr: "",
          };
        }
        return { stdout: "{}", stderr: "" };
      },
    });

    expect(result).toEqual({
      status: "spawned",
      scheduleId: "sched-spawn-1",
      paneId: "wBeats:p2",
      label,
      created: true,
      ack: true,
    });
    expect(calls).toContainEqual([
      "herdr",
      "tab",
      "create",
      "--workspace",
      "wBeats",
      "--label",
      label,
      "--no-focus",
    ]);
    expect(calls).toContainEqual(["herdr", "pane", "rename", "wBeats:p2", label]);
  });

  test("leaves the schedule unacked while the lane is busy", async () => {
    const label = "⏰ Campaign Pulse";
    const result = await executeSpawnBeat(spawnEntry, {
      briefExists: () => true,
      readBriefTitle: () => "Campaign Pulse",
      runCommand: async (argv) => {
        if (argv.join(" ") === "herdr pane list") {
          return {
            stdout: JSON.stringify({
              result: {
                panes: [{ pane_id: "w9:p1", label, agent_status: "working", workspace_id: "w9" }],
              },
            }),
            stderr: "",
          };
        }
        if (argv.join(" ") === "herdr agent list") {
          return {
            stdout: JSON.stringify({
              result: { agents: [{ pane_id: "w9:p1", agent_status: "working" }] },
            }),
            stderr: "",
          };
        }
        if (argv.join(" ") === "herdr workspace list") {
          return { stdout: JSON.stringify({ result: { workspaces: [] } }), stderr: "" };
        }
        throw new Error(`unexpected command ${argv.join(" ")}`);
      },
    });
    expect(result).toEqual({
      status: "busy",
      scheduleId: "sched-spawn-1",
      paneId: "w9:p1",
      label,
      ack: false,
    });
  });
});

describe("beat lane survives a pane rename", () => {
  test("reuses the registered pane even after herdr-name-sync rewrote its label", () => {
    // The pi name-sync extension renames a worker pane to the pi session name
    // on every turn, so "⏰ Campaign Pulse" becomes "📈 Campaign Pulse". Label
    // matching alone spawned a fresh pane every hour — ten panes in ten tabs.
    const plan = planSpawnBeat({
      entry: spawnEntry,
      briefExists: true,
      label: "⏰ Campaign Pulse",
      knownPaneId: "wB:p1",
      panes: [{ pane_id: "wB:p1", label: "📈 Campaign Pulse", agent_status: "done", workspace_id: "wB" }],
      agents: [{ pane_id: "wB:p1", agent_status: "done" }],
      workspaces: [{ workspace_id: "wB", label: SCHEDULED_BEATS_WORKSPACE_LABEL }],
    });
    expect(plan).toMatchObject({ action: "reuse", paneId: "wB:p1", mode: "prompt" });
  });

  test("creates a lane when the registered pane is gone", () => {
    const plan = planSpawnBeat({
      entry: spawnEntry,
      briefExists: true,
      label: "⏰ Campaign Pulse",
      knownPaneId: "wB:pGONE",
      panes: [],
      workspaces: [{ workspace_id: "wB", label: SCHEDULED_BEATS_WORKSPACE_LABEL }],
    });
    expect(plan).toMatchObject({ action: "create", workspaceId: "wB" });
  });

  test("the lane key is the brief path, not the mutable label", () => {
    expect(beatLaneKey(spawnEntry)).toBe(spawnEntry.briefPath);
  });
});
