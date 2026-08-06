import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { runJson } from "./process.mjs";

function target(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("target must be a non-empty string");
  return value.trim();
}

const DEFAULT_TASK_DIR = "/tmp/joelclaw/gateway-tasks";
const DEFAULT_WORKER_DIR = "/tmp/joelclaw/gateway-workers";
const WORKER_TAB_LABEL = "🛠️ gateway workers";
const GATEWAY_LOOP_LABEL = "📨 gateway loop";
const WORKER_CWD = "/Users/joel/Code/joelhooks/joelclaw";

/**
 * How many worker panes the gateway may hold open at once. Dispatch used to
 * degrade into one new tab per firing, forever; now it degrades into a refusal
 * that names the busy lanes.
 */
export const MAX_WORKER_LANES = 4;

const TERMINAL_OUTCOMES = new Set(["committed", "rejected", "no-changes-needed", "abandoned"]);
/** Statuses that mean the pane's agent can accept a new prompt right now. */
const FREE_STATUSES = new Set(["idle", "done", "blocked"]);

/**
 * A lane is the durable identity of a worker; a taskId is one firing of it.
 * `campaign-pulse-2026-07-25-1700` and `campaign-pulse-2026-07-25-1800` are the
 * same lane, so an hourly beat reuses one warm pane instead of leaking a tab.
 */
export function laneFromTaskId(taskId) {
  const parts = taskId.split("-");
  while (parts.length > 1 && /^\d+$/u.test(parts.at(-1))) parts.pop();
  return parts.join("-");
}

export function laneLabel(lane) {
  return `🛠️ ${lane}`;
}

function assertSlug(value, field) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/u.test(value)) {
    throw new Error(`${field} must be a kebab-case slug`);
  }
  return value;
}

async function readRegistry(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeRegistry(dir, path, registry) {
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function paneIndex(panes) {
  const byId = new Map();
  const byLabel = new Map();
  for (const pane of panes) {
    if (typeof pane?.pane_id === "string") byId.set(pane.pane_id, pane);
    if (typeof pane?.label === "string" && !byLabel.has(pane.label)) byLabel.set(pane.label, pane);
  }
  return { byId, byLabel };
}

/** Drop lanes whose pane no longer exists. Panes die; the registry must not lie. */
function pruneRegistry(registry, byId) {
  const live = {};
  for (const [lane, entry] of Object.entries(registry)) {
    if (typeof entry?.paneId === "string" && byId.has(entry.paneId)) live[lane] = entry;
  }
  return live;
}

function sameSlackWorkRequest(entry, cwd, resultContext) {
  return entry?.sourceCwd === cwd
    && entry?.resultContext?.sourceEventId === resultContext.sourceEventId
    && entry?.resultContext?.channelId === resultContext.channelId
    && entry?.resultContext?.replyThreadId === resultContext.replyThreadId;
}

function workerBrief({ taskId, task, cwd, resultContext = {} }) {
  const resultData = JSON.stringify({ taskId, ...resultContext });
  const progressData = JSON.stringify({ taskId, workerPhase: "progress", ...resultContext });
  return [
    `# Gateway worker task: ${taskId}`,
    "",
    `Launch contract cwd: \`${cwd}\``,
    "",
    "Before work, run `pwd` and `git rev-parse --show-toplevel` when this is a Git repo. Stop and report a launch-contract mismatch instead of searching other repositories.",
    "",
    task.trim(),
    "",
    "## Progress updates",
    "After you verify the launch contract and understand the task, append one short private progress receipt:",
    "",
    "```bash",
    `joelclaw notify send "worker ${taskId} progress: <what you found and what you are doing next>" --kind receipt --source shitrat-worker --context '${progressData}'`,
    "```",
    "",
    "Send another progress receipt after a meaningful milestone or after 10 minutes without an update. Do not send heartbeat spam. Never include secrets or private source text. The gateway projects these receipts into the originating Slack thread.",
    "",
    "## Returning your result",
    "When finished, append one private worker-result receipt to the gateway (this is the ONLY return path):",
    "",
    "```bash",
    `joelclaw notify send "worker ${taskId} done: <one-paragraph result>" --kind receipt --source shitrat-worker --context '${resultData}'`,
    "```",
    "",
    "This command appends a receipt. It does not authorize a direct Slack post. Never run `jc-slack reply`, call the Slack API, or use any other outward transport.",
    "Then print DONE and stop. Do not commit anything. The gateway alone decides and sends the one outward result.",
  ].join("\n");
}

export function createHerdrTools({
  run = runJson,
  now = () => Date.now(),
  taskDir = DEFAULT_TASK_DIR,
  workerDir = DEFAULT_WORKER_DIR,
} = {}) {
  const TASK_DIR = taskDir;
  const WORKER_DIR = workerDir;
  const LANE_REGISTRY = `${workerDir}/lanes.json`;
  const HARVEST_LOG = `${workerDir}/harvest.log`;
  const loadRegistry = () => readRegistry(LANE_REGISTRY);
  const saveRegistry = (registry) => writeRegistry(WORKER_DIR, LANE_REGISTRY, registry);

  const paneList = async () => {
    const panes = await run("herdr", ["pane", "list"]);
    return panes?.result?.panes ?? [];
  };

  /** Every reusable worker pane lives in one tab, so recurring beats do not grow the tab bar. */
  const openLanePane = async ({ panes, workspace, cwd }) => {
    const host = panes.find(
      (pane) => typeof pane.label === "string" && pane.label.startsWith("🛠️ ") && pane.workspace_id === workspace,
    );
    if (host?.pane_id) {
      const split = await run("herdr", [
        "pane", "split", host.pane_id, "--direction", "down", "--ratio", "0.5",
        "--cwd", cwd, "--no-focus",
      ]);
      const paneId = split?.result?.pane?.pane_id;
      if (paneId) return paneId;
    }
    const created = await run("herdr", [
      "tab", "create", "--workspace", workspace, "--label", WORKER_TAB_LABEL,
      "--cwd", cwd, "--no-focus",
    ]);
    const paneId = created?.result?.root_pane?.pane_id;
    if (!paneId) throw new Error(`tab create returned no pane: ${JSON.stringify(created)}`);
    return paneId;
  };

  return {
    snapshot: async () => {
      const [agents, panes] = await Promise.all([
        run("herdr", ["agent", "list"]),
        run("herdr", ["pane", "list"]),
      ]);
      return { agents, panes, capturedAt: new Date(now()).toISOString() };
    },
    read: ({ target: rawTarget, lines = 80, source = "recent-unwrapped" }) =>
      run("herdr", ["agent", "read", target(rawTarget), "--source", source, "--lines", String(lines)]),
    prompt: ({ target: rawTarget, text, wait = false, timeoutMs = 120_000 }) => {
      if (typeof text !== "string" || text.trim() === "") throw new Error("text must be a non-empty string");
      const args = ["agent", "prompt", target(rawTarget), text];
      if (wait) args.push("--wait", "--timeout", String(timeoutMs));
      return run("herdr", args, { timeout: wait ? timeoutMs + 5_000 : 30_000 });
    },
    wait: ({ target: rawTarget, states = ["idle", "done", "blocked"], timeoutMs = 120_000 }) => {
      const args = ["agent", "wait", target(rawTarget), "--timeout", String(timeoutMs)];
      for (const state of states) args.push("--until", state);
      return run("herdr", args, { timeout: timeoutMs + 5_000 });
    },

    /** Every live worker lane, so the gateway can see its own footprint. */
    workers: async () => {
      const panes = await paneList();
      const { byId } = paneIndex(panes);
      const registry = pruneRegistry(await loadRegistry(), byId);
      await saveRegistry(registry);
      return {
        max: MAX_WORKER_LANES,
        lanes: Object.entries(registry).map(([lane, entry]) => ({
          lane,
          ...entry,
          status: byId.get(entry.paneId)?.agent_status ?? "unknown",
        })),
      };
    },

    /**
     * Dispatch a task to a worker. Reuses the lane's existing pane whenever one
     * exists — warm session, no new tab. Only opens a pane when the lane has
     * none, and refuses past MAX_WORKER_LANES rather than sprawling.
     */
    dispatchWorker: async ({
      taskId,
      label,
      task,
      lane: rawLane,
      cwd: rawCwd,
      freshWorkspace = false,
      worktree = false,
      resultContext = {},
    }) => {
      assertSlug(taskId, "taskId");
      if (typeof task !== "string" || task.trim().length === 0) throw new Error("task must be non-empty");
      const lane = assertSlug(rawLane?.trim() || laneFromTaskId(taskId), "lane");
      const cwd = rawCwd?.trim() || WORKER_CWD;
      if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
      if (!resultContext || typeof resultContext !== "object" || Array.isArray(resultContext)) {
        throw new Error("resultContext must be an object");
      }

      const panes = await paneList();
      const { byId, byLabel } = paneIndex(panes);
      const registry = pruneRegistry(await loadRegistry(), byId);

      const slackWork = resultContext.platform === "slack";
      if (slackWork && (!freshWorkspace || !worktree)) {
        throw new Error("Slack work requires freshWorkspace:true and worktree:true; warm-pane reuse is forbidden");
      }

      await mkdir(TASK_DIR, { recursive: true });
      const taskFile = `${TASK_DIR}/${taskId}.md`;
      await writeFile(taskFile, workerBrief({ taskId, task, cwd, resultContext }), "utf8");
      // Gateway-created worktrees are isolated clones of an explicitly mapped
      // repository. Pi's interactive trust prompt can otherwise strand the
      // worker before it reads the task while Herdr reports it as idle.
      const launch = `JOELCLAW_GATEWAY_WORKER=1 pi --approve @${taskFile} "Execute the task in the attached brief. Work autonomously. Print DONE when finished."`;

      if (freshWorkspace) {
        if (
          resultContext.platform !== "slack"
          || typeof resultContext.channelId !== "string"
          || typeof resultContext.replyThreadId !== "string"
        ) {
          throw new Error(
            "fresh Slack work requires resultContext.platform=slack plus channelId and replyThreadId",
          );
        }
        const registered = registry[lane];
        const existingFresh = byLabel.get(laneLabel(lane))
          ?? (registered?.paneId ? byId.get(registered.paneId) : undefined);
        if (existingFresh?.pane_id) {
          if (
            registered?.taskId === taskId
            && sameSlackWorkRequest(registered, cwd, resultContext)
          ) {
            return {
              taskId,
              lane,
              paneId: existingFresh.pane_id,
              workspaceId: registered.workspaceId,
              cwd: registered.cwd,
              sourceCwd: registered.sourceCwd ?? cwd,
              freshWorkspace: true,
              worktree: Boolean(registered.worktree),
              taskFile: registered.taskFile,
              reused: true,
              mode: "idempotent-existing",
              resultReturnsVia: "stream message.requested with payload.evidence.context.taskId and Slack resultContext",
            };
          }
          throw new Error(
            `fresh lane ${lane} already owns pane ${existingFresh.pane_id} for ${registered?.taskId ?? "unknown work"}. `
            + "Release it before dispatching another task.",
          );
        }
        if (Object.keys(registry).length >= MAX_WORKER_LANES) {
          const busy = Object.entries(registry)
            .map(([name, entry]) => `${name}(${byId.get(entry.paneId)?.agent_status ?? "unknown"})`)
            .join(", ");
          throw new Error(
            `worker ceiling reached: ${MAX_WORKER_LANES} lanes already open [${busy}]. `
            + "Release a finished lane with herdr_release_worker before dispatching a new one.",
          );
        }
        const workspaceLabel = label?.trim() || `[sr] ${lane}`;
        const created = worktree
          ? await run("herdr", [
              "worktree", "create", "--cwd", cwd,
              "--branch", `shitrat/${taskId}`,
              "--label", workspaceLabel,
              "--no-focus", "--json",
            ])
          : await run("herdr", [
              "workspace", "create", "--cwd", cwd,
              "--label", workspaceLabel,
              "--no-focus",
            ]);
        const paneId = created?.result?.root_pane?.pane_id;
        const workspaceId = created?.result?.workspace?.workspace_id;
        const resolvedCwd = created?.result?.worktree?.path || cwd;
        if (!paneId || !workspaceId) {
          throw new Error(`fresh workspace returned no pane/workspace: ${JSON.stringify(created)}`);
        }
        await writeFile(taskFile, workerBrief({ taskId, task, cwd: resolvedCwd, resultContext }), "utf8");
        await run("herdr", ["pane", "rename", paneId, laneLabel(lane)]);
        await run("herdr", ["pane", "run", paneId, launch]);
        registry[lane] = {
          paneId,
          workspaceId,
          taskId,
          taskFile,
          cwd: resolvedCwd,
          sourceCwd: cwd,
          worktree: Boolean(worktree),
          dispatchedAt: now(),
          label: label ?? null,
          resultContext,
        };
        await saveRegistry(registry);
        return {
          taskId,
          lane,
          paneId,
          workspaceId,
          cwd: resolvedCwd,
          sourceCwd: cwd,
          freshWorkspace: true,
          worktree: Boolean(worktree),
          taskFile,
          resultReturnsVia: "stream message.requested with payload.evidence.context.taskId and Slack resultContext",
        };
      }

      const gatewayPane = panes.find((pane) => pane.label === GATEWAY_LOOP_LABEL);
      const workspace = gatewayPane?.workspace_id;
      if (!workspace) throw new Error("gateway loop pane not found; cannot place reusable worker");

      const existing = byLabel.get(laneLabel(lane)) ?? byId.get(registry[lane]?.paneId);
      if (existing?.pane_id) {
        if (existing.agent_status === "working") {
          throw new Error(
            `lane ${lane} is busy on ${registry[lane]?.taskId ?? "an earlier task"} (pane ${existing.pane_id}). `
            + "Wait for its result, or pass an explicit distinct lane.",
          );
        }
        // A free agent takes the prompt in its warm session; a dead pane gets pi
        // relaunched in place. Either way the pane is reused, never duplicated.
        const mode = FREE_STATUSES.has(existing.agent_status) ? "prompted" : "relaunched";
        await run("herdr", mode === "prompted"
          ? ["agent", "prompt", existing.pane_id, `Next task: read ${taskFile} and execute it. Work autonomously. Print DONE when finished.`]
          : ["pane", "run", existing.pane_id, launch]);
        await run("herdr", ["pane", "rename", existing.pane_id, laneLabel(lane)]);
        registry[lane] = {
          paneId: existing.pane_id,
          taskId,
          taskFile,
          cwd,
          dispatchedAt: now(),
          label: label ?? null,
          resultContext,
        };
        await saveRegistry(registry);
        return {
          taskId, lane, paneId: existing.pane_id, reused: true, mode, taskFile,
          resultReturnsVia: "stream message.requested with payload.evidence.context.taskId",
        };
      }

      if (Object.keys(registry).length >= MAX_WORKER_LANES) {
        const busy = Object.entries(registry)
          .map(([name, entry]) => `${name}(${byId.get(entry.paneId)?.agent_status ?? "unknown"})`)
          .join(", ");
        throw new Error(
          `worker ceiling reached: ${MAX_WORKER_LANES} lanes already open [${busy}]. `
          + "Release a finished lane with herdr_release_worker before dispatching a new one.",
        );
      }

      const paneId = await openLanePane({ panes, workspace, cwd });
      await run("herdr", ["pane", "rename", paneId, laneLabel(lane)]);
      await run("herdr", ["pane", "run", paneId, launch]);
      registry[lane] = {
        paneId,
        taskId,
        taskFile,
        cwd,
        dispatchedAt: now(),
        label: label ?? null,
        resultContext,
      };
      await saveRegistry(registry);
      return {
        taskId, lane, paneId, reused: false, mode: "opened", taskFile,
        resultReturnsVia: "stream message.requested with payload.evidence.context.taskId",
      };
    },

    /**
     * Close the loop on a worker: record a truthful harvest receipt, then free
     * the lane. A dispatched worker whose result you already delivered is
     * finished work — say what happened to it and let the pane go.
     */
    releaseWorker: async ({ lane: rawLane, taskId, outcome, note, close = true }) => {
      if (!TERMINAL_OUTCOMES.has(outcome)) {
        throw new Error(`outcome must be one of ${[...TERMINAL_OUTCOMES].join(", ")}`);
      }
      const registry = await loadRegistry();
      const lane = rawLane?.trim()
        || (typeof taskId === "string"
          ? Object.keys(registry).find((name) => registry[name]?.taskId === taskId) ?? laneFromTaskId(taskId)
          : undefined);
      if (!lane) throw new Error("release needs a lane or a taskId");
      const entry = registry[lane];
      if (!entry) throw new Error(`no open lane named ${lane}`);

      const receipt = `Harvested ${entry.paneId} (lane ${lane}, task ${entry.taskId}): result reviewed; outcome: ${outcome}; pane may close.`;
      await mkdir(WORKER_DIR, { recursive: true });
      await appendFile(HARVEST_LOG, `${new Date(now()).toISOString()} ${receipt}${note ? ` — ${note}` : ""}\n`, "utf8");

      let closed = false;
      if (close) {
        try {
          if (entry.worktree && entry.workspaceId) {
            // Never force a dirty checkout away. A refusal keeps the lane open
            // so steering can inspect and harvest real worker changes.
            await run("herdr", [
              "worktree", "remove", "--workspace", entry.workspaceId, "--json",
            ]);
          } else {
            await run("herdr", ["pane", "close", entry.paneId]);
          }
          closed = true;
        } catch (error) {
          // A pane/workspace that already vanished is the outcome we wanted.
          if (!String(error).includes("not found")) throw error;
          closed = true;
        }
        delete registry[lane];
      } else {
        registry[lane] = { ...entry, releasedAt: now(), outcome };
      }
      await saveRegistry(registry);
      return { lane, paneId: entry.paneId, taskId: entry.taskId, outcome, closed, receipt };
    },
  };
}
