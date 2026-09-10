import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GatewayAlertInvestigator,
  type CommandResult,
  type CommandRunner,
  type GatewayAlertIncident,
} from "./gateway-alert-investigator";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type RecordedCommand = {
  readonly command: string;
  readonly args: readonly string[];
};

function commandResult(exitCode = 0, stdout = "{}\n", stderr = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

async function harness() {
  const root = join(tmpdir(), `gateway-alert-investigator-${crypto.randomUUID()}`);
  roots.push(root);
  const commands: RecordedCommand[] = [];
  const workspaces = new Set<string>();
  const workspaceLabels = new Map<string, string>();
  const paneByWorkspace = new Map<string, string>();
  const agents = new Set<string>();
  let malformedWorkspaceCreateOnce = false;
  let failRecoveryPromptOnce = false;
  let herdrReady = true;
  let launchctlReady = true;
  let modelReady = true;
  let modelProbeDelayMs = 0;
  let workspaceSequence = 0;
  let now = new Date("2026-09-10T18:00:00.000Z");

  const run: CommandRunner = async (input) => {
    commands.push({ command: input.command, args: input.args });
    if (input.command === "/fake/joelclaw") return commandResult();
    if (input.command === "/fake/launchctl") {
      if (launchctlReady) {
        herdrReady = true;
        return commandResult();
      }
      return commandResult(1, "", "launchd unavailable");
    }
    if (input.command !== "/fake/herdr") return commandResult(127, "", "unknown command");

    if (input.args[0] === "status") {
      return herdrReady ? commandResult() : commandResult(1, "", "not ready");
    }
    if (input.args[0] === "workspace" && input.args[1] === "get") {
      return workspaces.has(String(input.args[2]))
        ? commandResult()
        : commandResult(1, "", "not found");
    }
    if (input.args[0] === "workspace" && input.args[1] === "list") {
      return commandResult(
        0,
        JSON.stringify({
          result: {
            workspaces: [...workspaces].map((workspaceId) => ({
              workspace_id: workspaceId,
              label: workspaceLabels.get(workspaceId),
            })),
          },
        }),
      );
    }
    if (input.args[0] === "pane" && input.args[1] === "list") {
      const workspaceId = String(input.args[input.args.indexOf("--workspace") + 1]);
      const paneId = paneByWorkspace.get(workspaceId);
      return paneId
        ? commandResult(0, JSON.stringify({ result: { panes: [{ pane_id: paneId }] } }))
        : commandResult(1, "", "not found");
    }
    if (input.args[0] === "workspace" && input.args[1] === "create") {
      workspaceSequence += 1;
      const workspaceId = `w${workspaceSequence}`;
      const paneId = `${workspaceId}:p1`;
      const labelIndex = input.args.indexOf("--label");
      workspaces.add(workspaceId);
      workspaceLabels.set(workspaceId, String(input.args[labelIndex + 1]));
      paneByWorkspace.set(workspaceId, paneId);
      if (malformedWorkspaceCreateOnce) {
        malformedWorkspaceCreateOnce = false;
        return commandResult(0, "{}\n");
      }
      return commandResult(
        0,
        JSON.stringify({
          result: {
            workspace: { workspace_id: workspaceId },
            root_pane: { pane_id: paneId },
          },
        }),
      );
    }
    if (input.args[0] === "workspace" && input.args[1] === "rename") {
      return commandResult();
    }
    if (input.args[0] === "agent" && input.args[1] === "get") {
      return agents.has(String(input.args[2]))
        ? commandResult()
        : commandResult(1, "", "not found");
    }
    if (input.args[0] === "agent" && input.args[1] === "start") {
      agents.add(String(input.args[2]));
      return commandResult();
    }
    if (input.args[0] === "agent" && input.args[1] === "prompt") {
      if (failRecoveryPromptOnce && input.args.join(" ").includes("heartbeat recovered")) {
        failRecoveryPromptOnce = false;
        return commandResult(1, "", "prompt failed");
      }
      return commandResult();
    }
    return commandResult(1, "", `unexpected herdr args: ${input.args.join(" ")}`);
  };

  const statePath = join(root, "incident.json");
  const investigator = new GatewayAlertInvestigator({
    statePath,
    repoRoot: "/repo",
    herdrBin: "/fake/herdr",
    launchctlBin: "/fake/launchctl",
    joelclawBin: "/fake/joelclaw",
    retryMs: 300_000,
    commandRunner: run,
    modelProbe: async () => {
      now = new Date(now.getTime() + modelProbeDelayMs);
      if (!modelReady) throw new Error("dgx-glm model probe timed out");
    },
    insideHerdr: false,
    now: () => now,
    sleep: async () => undefined,
  });

  return {
    investigator,
    commands,
    workspaces,
    agents,
    setNow(value: Date) {
      now = value;
    },
    setHerdrReady(value: boolean) {
      herdrReady = value;
    },
    setLaunchctlReady(value: boolean) {
      launchctlReady = value;
    },
    setModelReady(value: boolean) {
      modelReady = value;
    },
    setModelProbeDelay(milliseconds: number) {
      modelProbeDelayMs = milliseconds;
    },
    makeNextWorkspaceReceiptMalformed() {
      malformedWorkspaceCreateOnce = true;
    },
    failNextRecoveryPrompt() {
      failRecoveryPromptOnce = true;
    },
    async state(): Promise<GatewayAlertIncident> {
      return JSON.parse(await readFile(statePath, "utf8")) as GatewayAlertIncident;
    },
  };
}

describe("GatewayAlertInvestigator", () => {
  test("opens one Herdr workspace and starts the requested DGX GLM Pi agent", async () => {
    const tested = await harness();
    const started = await tested.investigator.alert("missing");

    expect(started).toMatchObject({
      ok: true,
      action: "started",
      incident: {
        phase: "investigating",
        kind: "missing",
        workspaceId: "w1",
        paneId: "w1:p1",
      },
    });
    const start = tested.commands.find(
      (command) => command.args[0] === "agent" && command.args[1] === "start",
    );
    expect(start?.args).toContain("dgx-glm/glm-5.3-flash:high");
    expect(start?.args).toContain("w1:p1");
    const prompt = tested.commands.find(
      (command) => command.args[0] === "agent" && command.args[1] === "prompt",
    );
    expect(prompt?.args.join(" ")).toContain("Never start a second gateway");
  });

  test("deduplicates repeated checks for the same active incident", async () => {
    const tested = await harness();
    await tested.investigator.alert("missing");
    const firstCommandCount = tested.commands.length;

    const existing = await tested.investigator.alert("stale", 1900);

    expect(existing).toMatchObject({
      ok: true,
      action: "existing",
      incident: { phase: "investigating", kind: "stale", workspaceId: "w1" },
    });
    expect(
      tested.commands.filter(
        (command) => command.args[0] === "workspace" && command.args[1] === "create",
      ),
    ).toHaveLength(1);
    expect(
      tested.commands.filter(
        (command) => command.args[0] === "agent" && command.args[1] === "start",
      ),
    ).toHaveLength(1);
    expect(tested.commands.length).toBe(firstCommandCount + 3);
    expect(
      tested.commands.find(
        (command) =>
          command.args[0] === "workspace" &&
          command.args[1] === "rename" &&
          command.args.includes("[jc] gateway heartbeat stale · GLM investigating"),
      )?.args,
    ).toContain("[jc] gateway heartbeat stale · GLM investigating");
  });

  test("marks the workspace review-ready and asks the same agent for a recovery receipt", async () => {
    const tested = await harness();
    await tested.investigator.alert("missing");
    tested.setNow(new Date("2026-09-10T18:05:00.000Z"));

    const recovered = await tested.investigator.recover();
    const repeated = await tested.investigator.recover();

    expect(recovered).toMatchObject({
      ok: true,
      action: "recovered",
      incident: { phase: "recovered", workspaceId: "w1" },
    });
    expect(repeated.action).toBe("idle");
    expect(
      tested.commands.find(
        (command) =>
          command.args[0] === "workspace" &&
          command.args[1] === "rename" &&
          command.args.includes("[jc] gateway recovered · review ready"),
      )?.args,
    ).toContain("[jc] gateway recovered · review ready");
    const recoveryPrompts = tested.commands.filter(
      (command) =>
        command.args[0] === "agent" &&
        command.args[1] === "prompt" &&
        command.args.join(" ").includes("heartbeat recovered"),
    );
    expect(recoveryPrompts).toHaveLength(1);
  });

  test("retries recovery side effects before recording the incident recovered", async () => {
    const tested = await harness();
    await tested.investigator.alert("missing");
    tested.failNextRecoveryPrompt();

    const blocked = await tested.investigator.recover();
    const recovered = await tested.investigator.recover();

    expect(blocked).toMatchObject({
      ok: false,
      action: "blocked",
      incident: { phase: "recoveryBlocked", lastError: expect.stringContaining("prompt failed") },
    });
    expect(recovered).toMatchObject({
      ok: true,
      action: "recovered",
      incident: { phase: "recovered" },
    });
    expect(
      tested.commands.filter(
        (command) =>
          command.args[0] === "agent" &&
          command.args[1] === "prompt" &&
          command.args.join(" ").includes("heartbeat recovered"),
      ),
    ).toHaveLength(2);
  });

  test("kickstarts the default Aqua Herdr job before opening an incident", async () => {
    const tested = await harness();
    tested.setHerdrReady(false);

    const started = await tested.investigator.alert("missing");

    expect(started.action).toBe("started");
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("test requires process.getuid");
    expect(tested.commands.find((command) => command.command === "/fake/launchctl")?.args).toEqual([
      "kickstart",
      "-k",
      `gui/${uid}/com.joelclaw.herdr-server`,
    ]);
  });

  test("keeps the workspace and retries when the requested DGX model is unavailable", async () => {
    const tested = await harness();
    tested.setModelReady(false);
    tested.setModelProbeDelay(30_000);

    const blocked = await tested.investigator.alert("missing");

    expect(blocked).toMatchObject({
      ok: false,
      action: "blocked",
      incident: {
        phase: "blocked",
        workspaceId: "w1",
        paneId: "w1:p1",
        lastError: "dgx-glm model probe timed out",
      },
    });
    expect(
      tested.commands.filter(
        (command) => command.args[0] === "agent" && command.args[1] === "start",
      ),
    ).toHaveLength(0);

    tested.setNow(new Date("2026-09-10T18:05:00.000Z"));
    tested.setModelReady(true);
    tested.setModelProbeDelay(0);
    const retried = await tested.investigator.alert("missing");
    expect(retried).toMatchObject({
      ok: true,
      action: "started",
      incident: { phase: "investigating", workspaceId: "w1", attempt: 2 },
    });
    expect(
      tested.commands.filter(
        (command) => command.args[0] === "workspace" && command.args[1] === "create",
      ),
    ).toHaveLength(1);
  });

  test("backs off after a failed default Herdr start", async () => {
    const tested = await harness();
    tested.setHerdrReady(false);
    tested.setLaunchctlReady(false);

    const blocked = await tested.investigator.alert("missing");
    const commandCount = tested.commands.length;
    const stillBlocked = await tested.investigator.alert("missing");

    expect(blocked).toMatchObject({
      ok: false,
      action: "blocked",
      incident: { phase: "blocked", attempt: 1 },
    });
    expect(blocked.incident?.lastError).toContain("Could not start default Herdr");
    expect(stillBlocked.action).toBe("blocked");
    expect(tested.commands).toHaveLength(commandCount);
  });

  test("restarts a dead investigator in the existing incident workspace", async () => {
    const tested = await harness();
    const started = await tested.investigator.alert("missing");
    tested.agents.clear();

    const restarted = await tested.investigator.alert("missing");

    expect(restarted).toMatchObject({
      ok: true,
      action: "started",
      incident: { phase: "investigating", workspaceId: started.incident?.workspaceId },
    });
    expect(
      tested.commands.filter(
        (command) => command.args[0] === "workspace" && command.args[1] === "create",
      ),
    ).toHaveLength(1);
    expect(
      tested.commands.filter(
        (command) => command.args[0] === "agent" && command.args[1] === "start",
      ),
    ).toHaveLength(2);
  });

  test("discovers a created workspace after an ambiguous create receipt", async () => {
    const tested = await harness();
    tested.makeNextWorkspaceReceiptMalformed();

    const blocked = await tested.investigator.alert("missing");
    expect(blocked).toMatchObject({ ok: false, action: "blocked" });

    tested.setNow(new Date("2026-09-10T18:05:00.000Z"));
    const recovered = await tested.investigator.alert("missing");

    expect(recovered).toMatchObject({
      ok: true,
      action: "started",
      incident: { phase: "investigating", workspaceId: "w1", paneId: "w1:p1" },
    });
    expect(
      tested.commands.filter(
        (command) => command.args[0] === "workspace" && command.args[1] === "create",
      ),
    ).toHaveLength(1);
  });

  test("opens a replacement workspace when the active incident workspace disappeared", async () => {
    const tested = await harness();
    const started = await tested.investigator.alert("missing");
    tested.workspaces.delete(String(started.incident?.workspaceId));
    tested.agents.clear();

    const replaced = await tested.investigator.alert("missing");

    expect(replaced).toMatchObject({
      ok: true,
      action: "started",
      incident: { phase: "investigating", workspaceId: "w2", paneId: "w2:p1" },
    });
    expect(
      tested.commands.filter(
        (command) => command.args[0] === "workspace" && command.args[1] === "create",
      ),
    ).toHaveLength(2);
  });
});
