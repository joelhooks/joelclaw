import { execFileSync } from "node:child_process";
import { infer } from "../../../lib/inference";
import { inngest } from "../../client";

const GARDEN_MARKER = "Garden consolidation (channel intelligence)";

type ChannelSource = "email" | "slack";
type DriftDecisionType = "keep" | "escalate" | "complete" | "delete";

type TodoistTask = {
  id: string;
  content: string;
  description: string;
  priority: number;
  projectId?: string;
  labels: string[];
  url?: string;
};

type TodoistListEnvelope = {
  ok?: boolean;
  error?: string;
  result?: {
    tasks?: unknown[];
  };
  tasks?: unknown[];
};

type TodoistActivityEnvelope = {
  ok?: boolean;
  error?: string;
  result?: {
    events?: unknown[];
  };
};

type TodoistActivity = {
  objectId: string;
  eventType: string;
  date: string;
};

type TaskActivitySummary = {
  createdAt?: string;
  lastTouchedAt?: string;
  hasProgress: boolean;
};

type FrontMessage = {
  is_inbound?: boolean;
  date?: string;
};

type FrontReadEnvelope = {
  ok?: boolean;
  error?: string;
  result?: {
    conversation?: {
      status?: string;
      subject?: string;
      from?: {
        name?: string;
        email?: string;
      };
    };
    messages?: FrontMessage[];
  };
};

type ChannelTask = TodoistTask & {
  source: ChannelSource;
  sourceId?: string;
  personKey?: string;
  senderKey?: string;
  subjectKey?: string;
  channelId?: string;
  threadId?: string;
  inInbox: boolean;
  createdAt?: string;
  hasProgress: boolean;
};

type DuplicatePlan = {
  keepId: string;
  deleteIds: string[];
  reason: string;
};

type ConsolidationPlan = {
  keepId: string;
  mergedIds: string[];
};

type DriftDecision = {
  id: string;
  decision: DriftDecisionType;
  reason: string;
};

function runCli(command: string, args: string[], timeout = 60_000): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 6 * 1024 * 1024,
      env: { ...process.env },
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} ${args.join(" ")} failed: ${message}`);
  }
}

function runJsonCli<T>(command: string, args: string[], timeout = 60_000): T {
  const raw = runCli(command, args, timeout);
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} returned non-JSON output: ${message}`);
  }
}

function parseTodoistTask(value: unknown): TodoistTask | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  const content = String(row.content ?? "").trim();
  if (!id || !content) return null;

  const labelsRaw = row.labels;
  const labels = Array.isArray(labelsRaw)
    ? labelsRaw
      .map((label) => String(label).trim())
      .filter(Boolean)
    : [];

  return {
    id,
    content,
    description: String(row.description ?? "").trim(),
    priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 1,
    projectId: typeof row.projectId === "string" ? row.projectId : undefined,
    labels,
    url: typeof row.url === "string" ? row.url : undefined,
  };
}

function parseTodoistTasks(payload: unknown): TodoistTask[] {
  const envelope = payload as TodoistListEnvelope | null;
  if (envelope?.ok === false) {
    return [];
  }

  const rows = Array.isArray(envelope?.result?.tasks)
    ? envelope.result.tasks
    : Array.isArray(envelope?.tasks)
      ? envelope.tasks
      : Array.isArray(payload)
        ? payload
        : [];

  return rows
    .map(parseTodoistTask)
    .filter((task): task is TodoistTask => task !== null);
}

function parseTodoistActivity(payload: unknown): TodoistActivity[] {
  const envelope = payload as TodoistActivityEnvelope | null;
  if (envelope?.ok === false) return [];

  const rows = Array.isArray(envelope?.result?.events)
    ? envelope.result.events
    : [];

  return rows
    .map((row): TodoistActivity | null => {
      if (!row || typeof row !== "object") return null;
      const event = row as Record<string, unknown>;
      const objectId = String(event.objectId ?? "").trim();
      const eventType = String(event.eventType ?? "").trim().toLowerCase();
      const date = String(event.date ?? "").trim();
      if (!objectId || !eventType || !date) return null;
      return { objectId, eventType, date };
    })
    .filter((event): event is TodoistActivity => event !== null);
}

function toMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeActivity(events: TodoistActivity[]): Map<string, TaskActivitySummary> {
  const map = new Map<string, TaskActivitySummary>();

  for (const event of events) {
    const existing = map.get(event.objectId) ?? { hasProgress: false };
    const dateMs = toMs(event.date);

    if (event.eventType === "added") {
      if (!existing.createdAt || dateMs < toMs(existing.createdAt)) {
        existing.createdAt = event.date;
      }
    } else {
      existing.hasProgress = true;
    }

    if (!existing.lastTouchedAt || dateMs > toMs(existing.lastTouchedAt)) {
      existing.lastTouchedAt = event.date;
    }

    map.set(event.objectId, existing);
  }

  return map;
}

function extractSource(description: string): { source?: ChannelSource; sourceId?: string } {
  const sourceMatch = description.match(/Source:\s*(email|slack)(?:\s*\(([^\n)]+)\))?/iu);
  if (sourceMatch?.[1] === "email" || sourceMatch?.[1] === "slack") {
    return {
      source: sourceMatch[1],
      sourceId: sourceMatch[2]?.trim() || undefined,
    };
  }

  if (/source:\s*email/iu.test(description)) {
    return { source: "email" };
  }
  if (/source:\s*slack/iu.test(description)) {
    return { source: "slack" };
  }

  return {};
}

function extractPersonKey(task: TodoistTask): string | undefined {
  const text = `${task.content}\n${task.description}`;
  const patterns = [
    /(?:reply|respond|follow\s*up|message|dm|ping|contact|reach\s*out)\s+(?:to|with)\s+([A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+)?)/iu,
    /from:\s*([^\n<]+)(?:<[^>]+>)?/iu,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value) {
      return value.toLowerCase().replace(/[^a-z0-9\s]/giu, "").replace(/\s+/gu, " ").trim();
    }
  }

  return undefined;
}

function extractSenderKey(task: TodoistTask): string | undefined {
  const text = `${task.content}\n${task.description}`;
  const fromLine = text.match(/from:\s*([^\n<]+)(?:<[^>]+>)?/iu)?.[1]?.trim();
  if (!fromLine) return extractPersonKey(task);
  return fromLine.toLowerCase().replace(/[^a-z0-9\s]/giu, "").replace(/\s+/gu, " ").trim();
}

function extractSubjectKey(task: TodoistTask): string {
  const subjectCandidate = task.content.includes("re:")
    ? task.content.split(/re:/iu).slice(1).join("re:")
    : task.content;

  return subjectCandidate
    .toLowerCase()
    .replace(/\[[^\]]+\]/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function similarSubject(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;

  const leftTokens = left.split(" ").filter((token) => token.length > 2);
  const rightTokens = right.split(" ").filter((token) => token.length > 2);
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;

  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  const threshold = Math.max(2, Math.ceil(Math.min(leftTokens.length, rightTokens.length) * 0.6));
  return overlap >= threshold;
}

function addDuplicatePlan(
  plans: DuplicatePlan[],
  tasks: ChannelTask[],
  reason: string,
  claimed: Set<string>,
): void {
  if (tasks.length < 2) return;
  const sorted = [...tasks].sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  const keep = sorted[0];
  if (!keep) return;

  const deleteIds = sorted
    .slice(1)
    .map((task) => task.id)
    .filter((id) => !claimed.has(id));

  if (deleteIds.length === 0) return;

  for (const id of deleteIds) {
    claimed.add(id);
  }

  plans.push({
    keepId: keep.id,
    deleteIds,
    reason,
  });
}

function buildConsolidationNote(keepTask: ChannelTask, relatedTasks: ChannelTask[]): string {
  const lines = [
    `${GARDEN_MARKER}: ${new Date().toISOString()}`,
    `Primary task: ${keepTask.id}`,
    "Merged related tasks:",
    ...relatedTasks.map(
      (task) => `- ${task.id} (${task.source}) ${task.content.slice(0, 140)}`,
    ),
  ];

  return lines.join("\n").slice(0, 3900);
}

function parseDriftDecisions(value: unknown): DriftDecision[] {
  const rows = Array.isArray(value) ? value : [];

  return rows
    .map((row): DriftDecision | null => {
      if (!row || typeof row !== "object") return null;
      const candidate = row as Record<string, unknown>;
      const id = String(candidate.id ?? "").trim();
      const decision = String(candidate.decision ?? "").trim() as DriftDecisionType;
      const reason = String(candidate.reason ?? "").trim();
      if (!id) return null;
      if (!["keep", "escalate", "complete", "delete"].includes(decision)) return null;
      return { id, decision, reason: reason || "No reason provided" };
    })
    .filter((decision): decision is DriftDecision => decision !== null);
}

function parseJsonArrayFromText(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start === -1 || end <= start) return [];
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

export const channelIntelligenceGarden = inngest.createFunction(
  {
    id: "channel-intelligence-garden",
    name: "Channel Intelligence Garden",
    retries: 2,
    concurrency: {
      limit: 1,
      key: '"channel-intelligence-garden"',
    },
  },
  [
    { cron: "0 */6 * * *" },
    { event: "channel/intelligence.garden.requested" },
  ],
  async ({ step }) => {
    const fetched = await step.run("fetch-current-tasks", async () => {
      const listPayload = runJsonCli<TodoistListEnvelope>("todoist-cli", ["list", "--json"], 90_000);
      const listTasks = parseTodoistTasks(listPayload);

      let inboxTasks: TodoistTask[] = [];
      try {
        const inboxPayload = runJsonCli<TodoistListEnvelope>("todoist-cli", ["inbox", "--json"], 60_000);
        inboxTasks = parseTodoistTasks(inboxPayload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/No inbox project found/iu.test(message) && !/HTTP\s+503\b|Service Unavailable/iu.test(message)) {
          throw error;
        }
      }

      return { listTasks, inboxTasks };
    });

    const activityByTaskId = await step.run("load-task-activity", async () => {
      try {
        const activityPayload = runJsonCli<TodoistActivityEnvelope>(
          "todoist-cli",
          ["activity", "--type", "task", "--limit", "500", "--json"],
          60_000,
        );
        const events = parseTodoistActivity(activityPayload);
        return Object.fromEntries(mergeActivity(events));
      } catch (error) {
        console.warn(`[channel-intelligence-garden] todoist activity unavailable: ${String(error)}`);
        return {} as Record<string, TaskActivitySummary>;
      }
    });

    const channelTasks = await step.run("identify-channel-intelligence-tasks", async () => {
      const inboxIds = new Set(fetched.inboxTasks.map((task) => task.id));
      const allTaskMap = new Map<string, TodoistTask>();

      for (const task of [...fetched.listTasks, ...fetched.inboxTasks]) {
        allTaskMap.set(task.id, task);
      }

      const identified: ChannelTask[] = [];
      for (const task of allTaskMap.values()) {
        const sourceInfo = extractSource(task.description);
        const pipelineMarked =
          task.labels.some((label) => /channel[-_ ]?intelligence/iu.test(label)) ||
          /channel[-_ ]?intelligence/iu.test(task.description);

        if (!sourceInfo.source && !pipelineMarked) {
          continue;
        }

        const source = sourceInfo.source;
        if (source !== "email" && source !== "slack") {
          continue;
        }

        const sourceId = sourceInfo.sourceId;
        const threadParts = source === "slack" && sourceId ? sourceId.split(":") : [];
        const activity = activityByTaskId[task.id];

        identified.push({
          ...task,
          source,
          sourceId,
          personKey: extractPersonKey(task),
          senderKey: source === "email" ? extractSenderKey(task) : undefined,
          subjectKey: source === "email" ? extractSubjectKey(task) : undefined,
          channelId: source === "slack" ? threadParts[0]?.trim() || undefined : undefined,
          threadId: source === "slack" ? threadParts[1]?.trim() || undefined : undefined,
          inInbox: inboxIds.has(task.id),
          createdAt: activity?.createdAt,
          hasProgress: activity?.hasProgress ?? false,
        });
      }

      return identified;
    });

    const duplicateAndConsolidationPlan = await step.run("identify-duplicates", async () => {
      const duplicatePlans: DuplicatePlan[] = [];
      const consolidationPlans: ConsolidationPlan[] = [];
      const claimedDeleteIds = new Set<string>();

      const bySourceId = new Map<string, ChannelTask[]>();
      for (const task of channelTasks) {
        if (!task.sourceId) continue;
        const key = `${task.source}:${task.sourceId}`;
        const group = bySourceId.get(key) ?? [];
        group.push(task);
        bySourceId.set(key, group);
      }

      for (const [key, group] of bySourceId.entries()) {
        addDuplicatePlan(duplicatePlans, group, `same-source-id:${key}`, claimedDeleteIds);
      }

      const emailGroups: ChannelTask[][] = [];
      for (const task of channelTasks.filter((candidate) => candidate.source === "email")) {
        if (claimedDeleteIds.has(task.id)) continue;
        let matched = false;
        for (const group of emailGroups) {
          const leader = group[0];
          if (!leader || !leader.senderKey || !task.senderKey) continue;
          if (leader.senderKey !== task.senderKey) continue;
          if (!leader.subjectKey || !task.subjectKey) continue;
          if (!similarSubject(leader.subjectKey, task.subjectKey)) continue;
          group.push(task);
          matched = true;
          break;
        }
        if (!matched) {
          emailGroups.push([task]);
        }
      }

      for (const group of emailGroups) {
        addDuplicatePlan(duplicatePlans, group, "email-sender-subject-match", claimedDeleteIds);
      }

      const slackGroups = new Map<string, ChannelTask[]>();
      for (const task of channelTasks.filter((candidate) => candidate.source === "slack")) {
        if (claimedDeleteIds.has(task.id)) continue;
        if (!task.channelId || !task.threadId) continue;
        const key = `${task.channelId}:${task.threadId}`;
        const group = slackGroups.get(key) ?? [];
        group.push(task);
        slackGroups.set(key, group);
      }

      for (const [key, group] of slackGroups.entries()) {
        addDuplicatePlan(duplicatePlans, group, `slack-thread-match:${key}`, claimedDeleteIds);
      }

      const crossChannel = new Map<string, ChannelTask[]>();
      for (const task of channelTasks) {
        if (!task.personKey || claimedDeleteIds.has(task.id)) continue;
        const group = crossChannel.get(task.personKey) ?? [];
        group.push(task);
        crossChannel.set(task.personKey, group);
      }

      for (const group of crossChannel.values()) {
        const sources = new Set(group.map((task) => task.source));
        if (sources.size < 2 || group.length < 2) continue;
        const sorted = [...group].sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
        const keep = sorted[0];
        if (!keep) continue;
        const mergedIds = sorted.slice(1).map((task) => task.id).filter((id) => !claimedDeleteIds.has(id));
        if (mergedIds.length === 0) continue;
        consolidationPlans.push({ keepId: keep.id, mergedIds });
      }

      return {
        duplicatePlans,
        consolidationPlans,
      };
    });

    const staleResolution = await step.run("check-stale-email-tasks", async () => {
      const completeIds = new Set<string>();
      const reasonByTaskId: Record<string, string> = {};
      const metadataByTaskId: Record<string, { sender?: string; subject?: string; status?: string }> = {};
      const duplicateDeleteIds = new Set(
        duplicateAndConsolidationPlan.duplicatePlans.flatMap((plan) => plan.deleteIds),
      );

      for (const task of channelTasks) {
        if (task.source !== "email") continue;
        if (!task.sourceId) continue;
        if (duplicateDeleteIds.has(task.id)) continue;

        try {
          const payload = runJsonCli<FrontReadEnvelope>(
            "joelclaw",
            ["email", "read", "--id", task.sourceId],
            90_000,
          );

          if (payload.ok === false) {
            console.warn(
              `[channel-intelligence-garden] unable to read conversation ${task.sourceId}: ${payload.error ?? "unknown"}`,
            );
            continue;
          }

          const conversation = payload.result?.conversation;
          const messages = Array.isArray(payload.result?.messages) ? payload.result.messages : [];

          const sender = [conversation?.from?.name, conversation?.from?.email]
            .filter((part): part is string => Boolean(part))
            .join(" ")
            .trim();

          metadataByTaskId[task.id] = {
            sender: sender || undefined,
            subject: conversation?.subject,
            status: conversation?.status,
          };

          const archived = (conversation?.status ?? "").toLowerCase() === "archived";

          const taskCreatedMs = toMs(task.createdAt);
          const replied = messages.some((message) => {
            if (message.is_inbound !== false) return false;
            const messageMs = toMs(message.date);
            if (!messageMs) return false;
            if (!taskCreatedMs) return true;
            return messageMs > taskCreatedMs;
          });

          if (archived || replied) {
            completeIds.add(task.id);
            reasonByTaskId[task.id] = archived ? "front_archived" : "joel_replied";
          }
        } catch (error) {
          console.warn(
            `[channel-intelligence-garden] stale check failed for ${task.id}/${task.sourceId}: ${String(error)}`,
          );
        }
      }

      return {
        completeIds: [...completeIds],
        reasonByTaskId,
        metadataByTaskId,
      };
    });

    const driftDecisions = await step.run("evaluate-priority-drift", async () => {
      const duplicateDeleteIds = new Set(
        duplicateAndConsolidationPlan.duplicatePlans.flatMap((plan) => plan.deleteIds),
      );
      const staleCompleteIds = new Set(staleResolution.completeIds);

      const candidates = channelTasks
        .filter((task) => !duplicateDeleteIds.has(task.id))
        .filter((task) => !staleCompleteIds.has(task.id))
        .filter((task) => task.priority <= 2)
        .map((task) => {
          const createdMs = toMs(task.createdAt);
          const ageDays = createdMs
            ? Math.floor((Date.now() - createdMs) / (24 * 60 * 60 * 1_000))
            : 0;
          return {
            ...task,
            ageDays,
          };
        })
        .filter((task) => task.ageDays >= 3)
        .filter((task) => !task.hasProgress);

      if (candidates.length === 0) {
        return [] as DriftDecision[];
      }

      const prompt = [
        "You are gardening Todoist tasks produced by the channel intelligence pipeline.",
        "Decide for each task whether to keep, escalate, complete, or delete.",
        "Rules:",
        "- escalate: still relevant but languishing; raise urgency",
        "- complete: likely resolved elsewhere",
        "- delete: stale/non-actionable/noise",
        "- keep: still actionable with current priority",
        "Return strict JSON array of {id, decision, reason}.",
        "",
        "Tasks:",
        ...candidates.map((task) => [
          `id=${task.id}`,
          `title=${task.content}`,
          `source=${task.source}`,
          `sourceId=${task.sourceId ?? "unknown"}`,
          `priority=${task.priority}`,
          `ageDays=${task.ageDays}`,
          `hasProgress=${task.hasProgress}`,
          `inInbox=${task.inInbox}`,
          `description=${task.description.slice(0, 500) || "(empty)"}`,
        ].join(" | ")),
      ].join("\n");

      const result = await infer(prompt, {
        task: "classification",
        json: true,
        requireJson: true,
        requireTextOutput: true,
        system:
          "You evaluate Todoist task hygiene. Respond with JSON only. Every input id must have exactly one decision in ['keep','escalate','complete','delete'] and a concise reason.",
        component: "channel-intelligence-garden",
        action: "channel.intelligence.garden.priority_drift",
        metadata: {
          candidateCount: candidates.length,
        },
      });

      const rows = Array.isArray(result.data)
        ? result.data
        : parseJsonArrayFromText(result.text);

      return parseDriftDecisions(rows);
    });

    const execution = await step.run("execute-garden-actions", async () => {
      const taskById = new Map(channelTasks.map((task) => [task.id, task]));
      const completeReasons = new Map<string, string>();
      const deleteReasons = new Map<string, string>();
      const consolidationUpdates = new Map<string, string>();
      const driftById = new Map(driftDecisions.map((decision) => [decision.id, decision]));

      for (const [id, reason] of Object.entries(staleResolution.reasonByTaskId)) {
        completeReasons.set(id, reason);
      }

      for (const decision of driftDecisions) {
        if (decision.decision === "complete") {
          completeReasons.set(decision.id, `drift:${decision.reason}`);
        }
        if (decision.decision === "delete") {
          deleteReasons.set(decision.id, `drift:${decision.reason}`);
        }
      }

      for (const plan of duplicateAndConsolidationPlan.duplicatePlans) {
        for (const deleteId of plan.deleteIds) {
          deleteReasons.set(deleteId, `duplicate:${plan.reason}`);
        }
      }

      for (const plan of duplicateAndConsolidationPlan.consolidationPlans) {
        const keeper = taskById.get(plan.keepId);
        if (!keeper) continue;
        const relatedTasks = plan.mergedIds
          .map((id) => taskById.get(id))
          .filter((task): task is ChannelTask => task !== undefined);

        if (relatedTasks.length === 0) continue;

        const note = buildConsolidationNote(keeper, relatedTasks);
        if (keeper.description.includes(note)) continue;
        if (keeper.description.includes(GARDEN_MARKER)) continue;

        const nextDescription = [keeper.description, note]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 3900);

        consolidationUpdates.set(keeper.id, nextDescription);
      }

      for (const deleteId of deleteReasons.keys()) {
        completeReasons.delete(deleteId);
      }

      let completed = 0;
      let deleted = 0;
      let escalated = 0;
      let duplicatesRemoved = 0;
      let descriptionUpdated = 0;

      for (const [taskId, reason] of deleteReasons.entries()) {
        try {
          runCli("todoist-cli", ["delete", taskId], 20_000);
          deleted += 1;
          if (reason.startsWith("duplicate:")) {
            duplicatesRemoved += 1;
          }
          console.log(`[channel-intelligence-garden] deleted ${taskId} (${reason})`);
        } catch (error) {
          console.error(`[channel-intelligence-garden] failed deleting ${taskId}: ${String(error)}`);
        }
      }

      for (const [taskId, reason] of completeReasons.entries()) {
        try {
          runCli("todoist-cli", ["complete", taskId], 20_000);
          completed += 1;
          console.log(`[channel-intelligence-garden] completed ${taskId} (${reason})`);
        } catch (error) {
          console.error(`[channel-intelligence-garden] failed completing ${taskId}: ${String(error)}`);
        }
      }

      for (const [taskId, decision] of driftById.entries()) {
        if (decision.decision !== "escalate") continue;
        if (deleteReasons.has(taskId) || completeReasons.has(taskId)) continue;

        const task = taskById.get(taskId);
        if (!task || task.priority >= 3) continue;

        try {
          runCli("todoist-cli", ["update", taskId, "--priority", "3"], 20_000);
          escalated += 1;
          console.log(`[channel-intelligence-garden] escalated ${taskId} (${decision.reason})`);
        } catch (error) {
          console.error(`[channel-intelligence-garden] failed escalating ${taskId}: ${String(error)}`);
        }
      }

      for (const [taskId, description] of consolidationUpdates.entries()) {
        if (deleteReasons.has(taskId) || completeReasons.has(taskId)) continue;

        try {
          runCli("todoist-cli", ["update", taskId, "--description", description], 20_000);
          descriptionUpdated += 1;
          console.log(`[channel-intelligence-garden] consolidated ${taskId}`);
        } catch (error) {
          console.error(`[channel-intelligence-garden] failed consolidating ${taskId}: ${String(error)}`);
        }
      }

      return {
        completed,
        deleted,
        escalated,
        duplicatesRemoved,
        descriptionUpdated,
      };
    });

    return step.run("return-summary", async () => ({
      reviewed: channelTasks.length,
      completed: execution.completed,
      deleted: execution.deleted,
      escalated: execution.escalated,
      duplicatesRemoved: execution.duplicatesRemoved,
    }));
  },
);
