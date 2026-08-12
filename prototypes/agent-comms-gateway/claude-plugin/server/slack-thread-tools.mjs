import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createMessageEventLogClient } from "@joelclaw/message-event-log";
import { loadSlackProjectCandidates } from "../../../../packages/gateway/src/slack-project-candidates.ts";
import {
  SlackThreadSessionRegistry,
} from "../../../../packages/gateway/src/slack-thread-session.ts";
import { runJson } from "./process.mjs";

const NEUTRAL_CWD = "/Users/joel/.joelclaw/slack-thread-neutral";
const TASK_DIR = "/tmp/joelclaw/slack-thread-sessions";
const RESOLUTION_CONFIDENCE = 0.76;

function nonEmpty(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40) || "thread";
}

function agentReadText(output) {
  const candidates = [
    output?.result?.content,
    output?.result?.text,
    output?.result?.output,
    output?.content,
    output?.text,
  ];
  const value = candidates.find((candidate) =>
    typeof candidate === "string" && candidate.trim());
  if (!value) throw new Error("Slack thread session returned no readable Pi answer");
  return value.trim().slice(-12_000);
}

function rootFromBinding(binding) {
  return binding?.cwd?.trim() || binding?.repo?.trim();
}

function sessionPrompt(input) {
  const project = input.binding
    ? `Verified project binding: ${JSON.stringify(input.binding)}`
    : "No project is bound. You are in the neutral ShitRat control session. Do not inspect or modify a project until a later explicit verified rebind.";
  return [
    "# Slack thread session",
    "",
    `Slack channel: ${input.channelName}`,
    `Slack root thread: ${input.threadId}`,
    project,
    "",
    "You are ShitRat in one continuing Slack thread. Reply to the newest human message using the supplied thread context. Keep the outward answer under 1200 characters, with short paragraphs and Slack mrkdwn. Do not mention internal routing, Herdr, Pi, tokens, or this task file unless it directly answers the question.",
    "",
    "Never call Slack, jc-slack, joelclaw notify, Discord, Telegram, or another outward transport. Your final assistant text is a private result. The gateway alone sends it.",
    "",
    `Full recent Slack thread:\n${input.threadText}`,
    "",
    `Newest human message:\n${input.text}`,
  ].join("\n");
}

export function createSlackThreadTools({
  run = runJson,
  registry = new SlackThreadSessionRegistry(),
  loadCandidates = loadSlackProjectCandidates,
  eventLog = createMessageEventLogClient(),
  neutralCwd = NEUTRAL_CWD,
  taskDir = TASK_DIR,
} = {}) {
  async function verifiedCandidates(input) {
    return loadCandidates({
      channelName: input.channelName,
      currentBinding: input.binding,
    });
  }

  async function resolveProject({ channelName, binding, projectId, projectConfidence = 0 }) {
    const candidates = await verifiedCandidates({ channelName, binding });
    const selected = candidates.find((candidate) => candidate.id === projectId);
    return {
      candidates,
      selected: selected && Number(projectConfidence) >= RESOLUTION_CONFIDENCE
        ? selected
        : undefined,
    };
  }

  async function runTurn({
    channelId,
    channelName,
    threadTs,
    text,
    threadText = "",
    binding,
    projectId,
    projectConfidence = 0,
    sourceEventId,
  }) {
    nonEmpty(channelId, "channelId");
    nonEmpty(channelName, "channelName");
    nonEmpty(threadTs, "threadTs");
    nonEmpty(text, "text");
    nonEmpty(sourceEventId, "sourceEventId");
    const current = await registry.activate({
      channelId,
      channelName,
      threadTs,
    });
    const inferred = await resolveProject({
      channelName,
      binding: current.binding ?? binding,
      projectId,
      projectConfidence,
    });
    const effectiveBinding = current.binding ?? inferred.selected?.binding;
    if (effectiveBinding && !current.binding) {
      await registry.activate({
        channelId,
        channelName,
        threadTs,
        binding: effectiveBinding,
      });
    }
    const claim = await registry.claimTurn({
      channelId,
      threadTs,
      sourceEventId,
    });
    if (!claim.claimed && claim.session.currentTurn?.state !== "claimed") {
      return {
        threadId: claim.session.threadId,
        sessionId: claim.session.sessionId,
        paneId: claim.session.paneId,
        workspaceId: claim.session.workspaceId,
        cwd: rootFromBinding(claim.session.binding) ?? neutralCwd,
        bound: Boolean(claim.session.binding),
        binding: claim.session.binding ?? null,
        idempotent: true,
      };
    }
    const cwd = rootFromBinding(effectiveBinding) ?? neutralCwd;
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) {
      throw new Error(`Slack thread session cwd is not a directory: ${cwd}`);
    }
    let active = await registry.get(channelId, threadTs);
    await mkdir(taskDir, { recursive: true });
    const sessionId = active?.sessionId || active?.plannedSessionId || randomUUID();
    const workspaceLabel = active?.plannedWorkspaceLabel || `[sr] ${slug(channelName)} thread`;
    if (!active?.plannedSessionId || !active?.plannedWorkspaceLabel) {
      active = await registry.activate({ channelId, channelName, threadTs });
      await registry.attachPlan({
        channelId,
        threadTs,
        plannedSessionId: sessionId,
        plannedWorkspaceLabel: workspaceLabel,
      });
      active = await registry.get(channelId, threadTs);
    }
    const taskFile = `${taskDir}/${slug(`${channelName}-${threadTs}`)}.md`;
    await writeFile(taskFile, sessionPrompt({
      channelName,
      threadId: `slack:${channelId}:${threadTs}`,
      binding: effectiveBinding,
      threadText: String(threadText).slice(-12_000),
      text,
    }), "utf8");

    let paneId = active?.paneId;
    let workspaceId = active?.workspaceId;
    if (paneId) {
      const panes = await run("herdr", ["pane", "list"]);
      const pane = panes?.result?.panes?.find((candidate) => candidate.pane_id === paneId);
      if (!pane) paneId = undefined;
      else if (pane.agent_status === "working") {
        throw new Error(
          `Slack thread session ${active?.threadId} is still working; queue this follow-up after the current turn`,
        );
      } else {
        await run("herdr", [
          "agent", "prompt", paneId,
          `Continue this Slack thread. Read ${taskFile}, answer the newest human message, then stop.`,
        ]);
      }
    }

    let needsLaunch = false;
    if (!paneId) {
      const [workspaces, panes] = await Promise.all([
        run("herdr", ["workspace", "list"]),
        run("herdr", ["pane", "list"]),
      ]);
      const plannedWorkspace = workspaces?.result?.workspaces?.find((candidate) =>
        candidate.label === workspaceLabel);
      const plannedPane = panes?.result?.panes?.find((candidate) =>
        candidate.workspace_id === plannedWorkspace?.workspace_id);
      if (plannedPane?.pane_id) {
        paneId = plannedPane.pane_id;
        workspaceId = plannedPane.workspace_id;
        needsLaunch = !plannedPane.agent;
      }
    }

    if (!paneId) {
      const created = await run("herdr", [
        "workspace", "create", "--cwd", cwd,
        "--label", workspaceLabel,
        "--no-focus",
      ]);
      paneId = created?.result?.root_pane?.pane_id;
      workspaceId = created?.result?.workspace?.workspace_id;
      if (!paneId || !workspaceId) {
        throw new Error(`Slack thread workspace returned no pane/workspace: ${JSON.stringify(created)}`);
      }
      needsLaunch = true;
    }

    if (needsLaunch) {
      await run("herdr", ["pane", "rename", paneId, `🐀 ${channelName} thread`]);
      await run("herdr", [
        "pane", "run", paneId,
        effectiveBinding
          ? `JOELCLAW_GATEWAY_WORKER=1 pi --approve --session-id ${sessionId} --name ${JSON.stringify(`🐀 ${channelName} thread`)} @${taskFile} "Own this Slack thread. Answer the newest human message, then stop."`
          : `JOELCLAW_GATEWAY_WORKER=1 pi --approve --no-context-files --no-skills --no-extensions --no-tools --session-id ${sessionId} --name ${JSON.stringify(`🐀 ${channelName} neutral thread`)} @${taskFile} "Own this neutral Slack thread. Answer only from the supplied Slack text, then stop."`,
      ]);
    }

    await registry.attachRuntime({
      channelId,
      threadTs,
      sessionId,
      paneId,
      workspaceId,
    });
    await registry.markTurnLaunched(channelId, threadTs, sourceEventId);
    return {
      threadId: `slack:${channelId}:${threadTs}`,
      sourceEventId,
      sessionId,
      paneId,
      workspaceId,
      cwd,
      bound: Boolean(effectiveBinding),
      binding: effectiveBinding ?? null,
      taskFile,
      candidates: inferred.candidates.map(({ id, label, root, source }) => ({
        id,
        label,
        root,
        source,
      })),
    };
  }

  async function status({ channelId, threadTs }) {
    const session = await registry.get(
      nonEmpty(channelId, "channelId"),
      nonEmpty(threadTs, "threadTs"),
    );
    if (!session) return { found: false };
    const pane = session.paneId
      ? await run("herdr", ["pane", "get", session.paneId]).catch(() => undefined)
      : undefined;
    return { found: true, session, pane };
  }

  async function read({ channelId, threadTs, sourceEventId, lines = 100 }) {
    const session = await registry.get(
      nonEmpty(channelId, "channelId"),
      nonEmpty(threadTs, "threadTs"),
    );
    if (!session?.paneId) throw new Error("Slack thread session has no live pane");
    nonEmpty(sourceEventId, "sourceEventId");
    if (session.currentTurn?.sourceEventId !== sourceEventId) {
      throw new Error(`Slack thread session is not running turn ${sourceEventId}`);
    }
    const paneResult = await run("herdr", ["pane", "get", session.paneId]);
    const status = paneResult?.result?.pane?.agent_status;
    if (!new Set(["idle", "done", "blocked"]).has(status)) {
      throw new Error(
        `Slack thread session ${session.threadId} is not settled (status=${status ?? "unknown"})`,
      );
    }
    const output = await run("herdr", [
      "agent", "read", session.paneId,
      "--source", "recent-unwrapped",
      "--lines", String(lines),
    ]);
    const text = agentReadText(output);
    const result = await eventLog.append({
      semanticKey: `slack-thread-result:${sourceEventId}`,
      kind: "message.requested",
      source: "shitrat-thread-session",
      platform: "slack",
      correlationId: sourceEventId,
      payload: {
        text,
        evidence: {
          context: {
            platform: "slack",
            channelId,
            replyThreadId: `slack:${channelId}:${threadTs}`,
            sourceEventId,
            threadSessionId: session.sessionId,
            workerPhase: "result",
          },
        },
      },
    });
    await registry.completeTurn(channelId, threadTs, sourceEventId);
    await registry.settle(channelId, threadTs);
    return {
      session: await registry.get(channelId, threadTs),
      output,
      resultEventId: result.eventId,
      text,
    };
  }

  async function resolve({ channelId, threadTs, quietTimeoutMs }) {
    return registry.resolve(
      nonEmpty(channelId, "channelId"),
      nonEmpty(threadTs, "threadTs"),
      Number.isSafeInteger(quietTimeoutMs) ? quietTimeoutMs : undefined,
    );
  }

  async function reap() {
    const due = await registry.retireDue();
    const retired = [];
    for (const session of due) {
      if (session.workspaceId) {
        await run("herdr", ["workspace", "close", session.workspaceId]).catch(() => undefined);
      } else if (session.paneId) {
        await run("herdr", ["pane", "close", session.paneId]).catch(() => undefined);
      }
      retired.push(session.threadId);
    }
    return { retired };
  }

  return {
    active: () => registry.listActive(),
    candidates: verifiedCandidates,
    runTurn,
    status,
    read,
    resolve,
    reap,
  };
}
