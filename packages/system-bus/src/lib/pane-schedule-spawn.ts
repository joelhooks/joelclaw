import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { PaneScheduleEntry } from "./pane-schedule";

export const SCHEDULED_BEATS_WORKSPACE_LABEL = "[jc] scheduled beats";
/**
 * Beats never land in the gateway's own workspace — that is the sprawl this
 * path exists to end. The workspace is identified by the pane that hosts the
 * gateway loop, not by a herdr workspace id: ids are assigned per session and
 * a hardcoded one silently stops protecting anything after a restart.
 */
export const GATEWAY_LOOP_PANE_LABEL = "📨 gateway loop";

export function forbiddenWorkspaceIds(panes: readonly HerdrPaneRecord[]): Set<string> {
  const forbidden = new Set<string>();
  for (const pane of panes) {
    if (pane.label === GATEWAY_LOOP_PANE_LABEL && typeof pane.workspace_id === "string") {
      forbidden.add(pane.workspace_id);
    }
  }
  return forbidden;
}

export type HerdrPaneRecord = {
  pane_id?: unknown;
  label?: unknown;
  agent_status?: unknown;
  workspace_id?: unknown;
  name?: unknown;
  agent_name?: unknown;
};

export type HerdrAgentRecord = {
  pane_id?: unknown;
  agent_status?: unknown;
  name?: unknown;
  agent_name?: unknown;
  label?: unknown;
};

export type HerdrWorkspaceRecord = {
  workspace_id?: unknown;
  label?: unknown;
};

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

export type SpawnBeatPlan =
  | {
      action: "reuse";
      paneId: string;
      label: string;
      mode: "prompt" | "run";
      launch: string;
    }
  | {
      action: "create";
      label: string;
      workspaceId?: string;
      createWorkspace: boolean;
      launch: string;
    }
  | {
      action: "busy";
      paneId: string;
      label: string;
      agentStatus: string;
    }
  | {
      action: "refuse";
      reason: string;
    };

export type SpawnBeatResult =
  | {
      status: "spawned" | "reused";
      scheduleId: string;
      paneId: string;
      label: string;
      created: boolean;
      ack: true;
    }
  | {
      status: "busy";
      scheduleId: string;
      paneId: string;
      label: string;
      ack: false;
    }
  | {
      status: "refused" | "failed";
      scheduleId: string;
      reason: string;
      ack: false;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function resultList(raw: string, key: string): Record<string, unknown>[] {
  const envelope = asRecord(JSON.parse(raw));
  const result = asRecord(envelope?.result);
  const value = result?.[key];
  if (!Array.isArray(value)) return [];
  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record) records.push(record);
  }
  return records;
}

export type BriefReader = (path: string, encoding: "utf8") => string;
export type PathExists = (path: string) => boolean;

export function titleFromBriefPath(
  briefPath: string,
  readFile: BriefReader = (path, encoding) => readFileSync(path, encoding),
  exists: PathExists = existsSync,
): string {
  if (!exists(briefPath)) return basename(briefPath).replace(/\.[^.]+$/u, "");
  try {
    const text = readFile(briefPath, "utf8");
    const frontmatterTitle = text.match(/^title:\s*["']?(.+?)["']?\s*$/mu)?.[1]?.trim();
    const headingTitle = text.match(/^#\s+(.+)$/mu)?.[1]?.trim();
    return frontmatterTitle || headingTitle || basename(briefPath).replace(/\.[^.]+$/u, "");
  } catch {
    return basename(briefPath).replace(/\.[^.]+$/u, "");
  }
}

export function scheduledBeatLabel(title: string): string {
  const clean = title
    .replace(/^Task:\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return `⏰ ${clean.slice(0, 48)}`;
}

export function beatLaneLabel(
  entry: Pick<PaneScheduleEntry, "briefPath" | "prompt">,
  readFile?: BriefReader,
  exists?: PathExists,
): string {
  if (!entry.briefPath) return scheduledBeatLabel(entry.prompt ?? "scheduled beat");
  if (readFile && exists) {
    return scheduledBeatLabel(titleFromBriefPath(entry.briefPath, readFile, exists));
  }
  if (readFile) {
    return scheduledBeatLabel(titleFromBriefPath(entry.briefPath, readFile));
  }
  if (exists) {
    return scheduledBeatLabel(
      titleFromBriefPath(
        entry.briefPath,
        (path, encoding) => readFileSync(path, encoding),
        exists,
      ),
    );
  }
  return scheduledBeatLabel(titleFromBriefPath(entry.briefPath));
}

export function buildSpawnLaunchCommand(entry: PaneScheduleEntry): string {
  const briefPath = entry.briefPath!;
  const cwd = dirname(briefPath);
  const prompt =
    entry.prompt?.trim() ||
    `Execute the scheduled SPAWN brief for scheduleId ${entry.scheduleId}. Work autonomously. Print DONE when finished.`;
  // Escape single quotes for a POSIX single-quoted string.
  const q = (value: string) => value.replace(/'/g, `'\\''`);
  return `cd '${q(cwd)}' && pi @'${q(briefPath)}' '${q(prompt)}'`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function agentStatusForPane(
  paneId: string,
  pane: HerdrPaneRecord | undefined,
  agents: readonly HerdrAgentRecord[],
): string {
  const agent = agents.find((entry) => stringField(entry.pane_id) === paneId);
  return (
    stringField(agent?.agent_status) ??
    stringField(pane?.agent_status) ??
    "unknown"
  );
}

export function planSpawnBeat(input: {
  entry: PaneScheduleEntry;
  panes: readonly HerdrPaneRecord[];
  agents?: readonly HerdrAgentRecord[];
  workspaces?: readonly HerdrWorkspaceRecord[];
  briefExists: boolean;
  label?: string;
  /**
   * The pane this lane used last time, from the durable registry. This is the
   * primary match — a label cannot be, because the `herdr-name-sync` pi
   * extension rewrites a worker's pane label to the pi session name on every
   * turn. Matching on label alone meant every firing failed to find its own
   * lane and opened a new pane: ten Campaign Pulse panes in ten tabs.
   */
  knownPaneId?: string;
}): SpawnBeatPlan {
  if (input.entry.verb !== "spawn") {
    return { action: "refuse", reason: `planSpawnBeat only handles verb spawn, got ${input.entry.verb}` };
  }
  if (!input.entry.briefPath) {
    return { action: "refuse", reason: "spawn requires briefPath" };
  }
  if (!input.briefExists) {
    return { action: "refuse", reason: `briefPath missing: ${input.entry.briefPath}` };
  }

  const label = input.label ?? beatLaneLabel(input.entry);
  const launch = buildSpawnLaunchCommand(input.entry);
  const forbidden = forbiddenWorkspaceIds(input.panes);
  const usable = (pane: HerdrPaneRecord | undefined): boolean => {
    if (!pane || typeof pane.pane_id !== "string") return false;
    const workspaceId = stringField(pane.workspace_id);
    return !(workspaceId && forbidden.has(workspaceId));
  };
  const registered = input.knownPaneId
    ? input.panes.find((pane) => stringField(pane.pane_id) === input.knownPaneId)
    : undefined;
  // Registry first, label only as a fallback for lanes predating the registry.
  const existing = usable(registered)
    ? registered
    : input.panes.find((pane) => {
        const paneLabel =
          stringField(pane.label) ?? stringField(pane.name) ?? stringField(pane.agent_name);
        return paneLabel === label && usable(pane);
      });

  if (existing && typeof existing.pane_id === "string") {
    const status = agentStatusForPane(existing.pane_id, existing, input.agents ?? []);
    if (status === "working" || status === "blocked") {
      return {
        action: "busy",
        paneId: existing.pane_id,
        label,
        agentStatus: status,
      };
    }
    const hasAgent = (input.agents ?? []).some(
      (agent) => stringField(agent.pane_id) === existing.pane_id,
    );
    return {
      action: "reuse",
      paneId: existing.pane_id,
      label,
      mode: hasAgent && (status === "idle" || status === "done") ? "prompt" : "run",
      launch,
    };
  }

  const workspace = (input.workspaces ?? []).find(
    (entry) => stringField(entry.label) === SCHEDULED_BEATS_WORKSPACE_LABEL,
  );
  const workspaceId = stringField(workspace?.workspace_id);
  if (workspaceId && forbidden.has(workspaceId)) {
    return {
      action: "refuse",
      reason: `scheduled beats workspace resolved to forbidden workspace ${workspaceId}`,
    };
  }

  return {
    action: "create",
    label,
    ...(workspaceId ? { workspaceId } : {}),
    createWorkspace: !workspaceId,
    launch,
  };
}

export type SpawnBeatPorts = {
  /** Defaults to a real herdr subprocess runner when omitted. */
  runCommand?: CommandRunner;
  briefExists?: (path: string) => boolean;
  readBriefTitle?: (path: string) => string;
  /** Durable lane registry: brief path -> pane id. Survives label rewrites. */
  readLanePane?: (laneKey: string) => Promise<string | undefined>;
  writeLanePane?: (laneKey: string, paneId: string) => Promise<void>;
};

/**
 * A lane is identified by its brief path, not its label. The schedule names the
 * brief and never changes it; labels are cosmetic and get rewritten underneath
 * us by the pi name-sync extension.
 */
export function beatLaneKey(entry: Pick<PaneScheduleEntry, "briefPath">): string {
  return entry.briefPath ?? "";
}

async function defaultCommand(argv: string[]): Promise<CommandResult> {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return { stdout, stderr };
}

/**
 * Mechanically execute a verb:spawn schedule into a stable herdr beat lane.
 * Reuses an existing idle/done pane with the lane label; never creates one tab
 * per firing. Does not touch the gateway judgment queue.
 */
export async function executeSpawnBeat(
  entry: PaneScheduleEntry,
  ports: SpawnBeatPorts = {},
): Promise<SpawnBeatResult> {
  const runCommand = ports.runCommand ?? defaultCommand;
  const briefExists = ports.briefExists ?? ((path: string) => existsSync(path));
  const label =
    entry.briefPath && ports.readBriefTitle
      ? scheduledBeatLabel(ports.readBriefTitle(entry.briefPath))
      : beatLaneLabel(entry);

  if (entry.verb !== "spawn") {
    return {
      status: "refused",
      scheduleId: entry.scheduleId,
      reason: `executeSpawnBeat only handles verb spawn, got ${entry.verb}`,
      ack: false,
    };
  }
  if (!entry.briefPath) {
    return {
      status: "refused",
      scheduleId: entry.scheduleId,
      reason: "spawn requires briefPath",
      ack: false,
    };
  }

  try {
    const [paneResult, agentResult, workspaceResult] = await Promise.all([
      runCommand(["herdr", "pane", "list"]),
      runCommand(["herdr", "agent", "list"]),
      runCommand(["herdr", "workspace", "list"]),
    ]);
    const panes = resultList(paneResult.stdout, "panes");
    const forbidden = forbiddenWorkspaceIds(panes);
    const laneKey = beatLaneKey(entry);
    const knownPaneId = ports.readLanePane ? await ports.readLanePane(laneKey) : undefined;
    const plan = planSpawnBeat({
      entry,
      panes,
      agents: resultList(agentResult.stdout, "agents"),
      workspaces: resultList(workspaceResult.stdout, "workspaces"),
      briefExists: briefExists(entry.briefPath),
      label,
      ...(knownPaneId ? { knownPaneId } : {}),
    });

    if (plan.action === "refuse") {
      return {
        status: "refused",
        scheduleId: entry.scheduleId,
        reason: plan.reason,
        ack: false,
      };
    }

    if (plan.action === "busy") {
      return {
        status: "busy",
        scheduleId: entry.scheduleId,
        paneId: plan.paneId,
        label: plan.label,
        ack: false,
      };
    }

    if (plan.action === "reuse") {
      if (plan.mode === "prompt") {
        await runCommand([
          "herdr",
          "agent",
          "prompt",
          plan.paneId,
          entry.prompt?.trim() ||
            `Scheduled SPAWN ${entry.scheduleId}. Re-run the attached brief at ${entry.briefPath}.`,
        ]);
      } else {
        await runCommand(["herdr", "pane", "run", plan.paneId, plan.launch]);
      }
      if (ports.writeLanePane) await ports.writeLanePane(laneKey, plan.paneId);
      return {
        status: "reused",
        scheduleId: entry.scheduleId,
        paneId: plan.paneId,
        label: plan.label,
        created: false,
        ack: true,
      };
    }

    let workspaceId = plan.workspaceId;
    if (plan.createWorkspace || !workspaceId) {
      const createdWorkspace = asRecord(
        JSON.parse(
          (
            await runCommand([
              "herdr",
              "workspace",
              "create",
              "--label",
              SCHEDULED_BEATS_WORKSPACE_LABEL,
            ])
          ).stdout,
        ),
      );
      const result = asRecord(createdWorkspace?.result);
      const workspace = asRecord(result?.workspace) ?? result;
      workspaceId = stringField(workspace?.workspace_id);
      if (!workspaceId) {
        // Some herdr versions return the root pane with workspace_id instead.
        const rootPane = asRecord(result?.root_pane);
        workspaceId = stringField(rootPane?.workspace_id);
      }
      if (!workspaceId) {
        throw new Error(
          `herdr workspace create returned no workspace id: ${JSON.stringify(createdWorkspace)}`,
        );
      }
      if (forbidden.has(workspaceId)) {
        throw new Error(`refusing to spawn into the gateway's own workspace ${workspaceId}`);
      }
      // workspace create already made a root pane — use it if present.
      const rootPane = asRecord(result?.root_pane);
      const rootPaneId = stringField(rootPane?.pane_id);
      if (rootPaneId) {
        await runCommand(["herdr", "pane", "rename", rootPaneId, plan.label]);
        await runCommand(["herdr", "pane", "run", rootPaneId, plan.launch]);
        if (ports.writeLanePane) await ports.writeLanePane(laneKey, rootPaneId);
        return {
          status: "spawned",
          scheduleId: entry.scheduleId,
          paneId: rootPaneId,
          label: plan.label,
          created: true,
          ack: true,
        };
      }
    }

    if (forbidden.has(workspaceId)) {
      throw new Error(`refusing to spawn into the gateway's own workspace ${workspaceId}`);
    }

    const created = asRecord(
      JSON.parse(
        (
          await runCommand([
            "herdr",
            "tab",
            "create",
            "--workspace",
            workspaceId,
            "--label",
            plan.label,
            "--no-focus",
          ])
        ).stdout,
      ),
    );
    const result = asRecord(created?.result);
    const rootPane = asRecord(result?.root_pane);
    const paneId = stringField(rootPane?.pane_id);
    if (!paneId) {
      throw new Error(`herdr tab create returned no root pane: ${JSON.stringify(created)}`);
    }
    await runCommand(["herdr", "pane", "rename", paneId, plan.label]);
    await runCommand(["herdr", "pane", "run", paneId, plan.launch]);
    if (ports.writeLanePane) await ports.writeLanePane(laneKey, paneId);
    return {
      status: "spawned",
      scheduleId: entry.scheduleId,
      paneId,
      label: plan.label,
      created: true,
      ack: true,
    };
  } catch (error) {
    return {
      status: "failed",
      scheduleId: entry.scheduleId,
      reason: error instanceof Error ? error.message : String(error),
      ack: false,
    };
  }
}
