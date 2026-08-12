import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackThreadSessionRegistry } from "../../../../packages/gateway/src/slack-thread-session.ts";
import { createSlackThreadTools } from "./slack-thread-tools.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeRun() {
  const calls = [];
  const panes = new Map();
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, args]);
      const op = args.slice(0, 2).join(" ");
      if (op === "workspace create") {
        panes.set("w1:p1", { pane_id: "w1:p1", agent_status: "idle" });
        return {
          result: {
            root_pane: { pane_id: "w1:p1" },
            workspace: { workspace_id: "w1" },
          },
        };
      }
      if (op === "pane list") return { result: { panes: [...panes.values()] } };
      if (op === "pane get") return { result: { pane: panes.get(args[2]) } };
      if (op === "agent read") return { result: { content: "thread answer" } };
      return { result: {} };
    },
  };
}

async function harness() {
  const root = join(tmpdir(), `slack-thread-tools-${crypto.randomUUID()}`);
  const project = join(root, "project");
  roots.push(root);
  await mkdir(project, { recursive: true });
  const registry = new SlackThreadSessionRegistry(join(root, "sessions.json"));
  const process = fakeRun();
  const candidates = [{
    id: "project-candidate",
    label: "Project",
    root: project,
    source: "binding",
    binding: { cwd: project, repo: project },
  }];
  const resultEvents = [];
  const tools = createSlackThreadTools({
    run: process.run,
    registry,
    eventLog: {
      append: async (input) => {
        resultEvents.push(input);
        return { eventId: "result-event-1" };
      },
    },
    loadCandidates: async () => candidates,
    neutralCwd: root,
    taskDir: join(root, "tasks"),
  });
  return { root, project, registry, process, tools, resultEvents };
}

describe("Slack thread Pi sessions", () => {
  test("binds only a verified high-confidence candidate", async () => {
    const tested = await harness();
    const result = await tested.tools.runTurn({
      channelId: "C1",
      channelName: "lc-project",
      threadTs: "1.000",
      text: "check the project",
      sourceEventId: "event-1",
      projectId: "project-candidate",
      projectConfidence: 0.9,
    });
    expect(result).toMatchObject({
      cwd: tested.project,
      bound: true,
      paneId: "w1:p1",
    });
    expect((await tested.registry.get("C1", "1.000"))?.binding?.cwd).toBe(tested.project);
  });

  test("stays neutral below the confidence floor", async () => {
    const tested = await harness();
    const result = await tested.tools.runTurn({
      channelId: "C1",
      channelName: "lc-project",
      threadTs: "1.000",
      text: "ambiguous thing",
      sourceEventId: "event-1",
      projectId: "project-candidate",
      projectConfidence: 0.4,
    });
    expect(result).toMatchObject({ cwd: tested.root, bound: false });
  });

  test("retries one source event idempotently without another prompt", async () => {
    const tested = await harness();
    const first = await tested.tools.runTurn({
      channelId: "C1",
      channelName: "lc-project",
      threadTs: "1.000",
      text: "first turn",
      sourceEventId: "event-1",
      projectId: "project-candidate",
      projectConfidence: 0.9,
    });
    const retry = await tested.tools.runTurn({
      channelId: "C1",
      channelName: "lc-project",
      threadTs: "1.000",
      text: "first turn",
      sourceEventId: "event-1",
      projectId: "project-candidate",
      projectConfidence: 0.9,
    });
    expect(retry).toMatchObject({
      idempotent: true,
      sessionId: first.sessionId,
      paneId: first.paneId,
    });
    expect(tested.process.calls.filter(([, args]) => args.slice(0, 2).join(" ") === "agent prompt")).toHaveLength(0);
  });

  test("emits one durable result event only after the Pi turn settles", async () => {
    const tested = await harness();
    await tested.tools.runTurn({
      channelId: "C1",
      channelName: "lc-project",
      threadTs: "1.000",
      text: "first turn",
      sourceEventId: "event-1",
      projectId: "project-candidate",
      projectConfidence: 0.9,
    });
    const result = await tested.tools.read({
      channelId: "C1",
      threadTs: "1.000",
      sourceEventId: "event-1",
    });
    expect(result).toMatchObject({ resultEventId: "result-event-1", text: "thread answer" });
    expect(tested.resultEvents[0]).toMatchObject({
      kind: "message.requested",
      source: "shitrat-thread-session",
      correlationId: "event-1",
      payload: {
        evidence: {
          context: {
            channelId: "C1",
            replyThreadId: "slack:C1:1.000",
            sourceEventId: "event-1",
          },
        },
      },
    });
  });

  test("reuses one pane and Pi session for later thread replies", async () => {
    const tested = await harness();
    const first = await tested.tools.runTurn({
      channelId: "C1",
      channelName: "lc-project",
      threadTs: "1.000",
      text: "first turn",
      sourceEventId: "event-1",
      projectId: "project-candidate",
      projectConfidence: 0.9,
    });
    await tested.registry.completeTurn("C1", "1.000", "event-1");
    await tested.registry.settle("C1", "1.000");
    const second = await tested.tools.runTurn({
      channelId: "C1",
      channelName: "lc-project",
      threadTs: "1.000",
      text: "follow-up turn",
      sourceEventId: "event-2",
      projectId: "project-candidate",
      projectConfidence: 0.9,
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.paneId).toBe(first.paneId);
    expect(tested.process.calls.filter(([, args]) => args.slice(0, 2).join(" ") === "workspace create")).toHaveLength(1);
    expect(tested.process.calls.some(([, args]) => args.slice(0, 2).join(" ") === "agent prompt")).toBe(true);
  });
});
