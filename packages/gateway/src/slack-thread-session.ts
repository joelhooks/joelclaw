import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { createActor, createMachine } from "xstate";
import type { SlackChannelContextBinding } from "./slack-work-request";

export const DEFAULT_SLACK_THREAD_SESSIONS_PATH = resolve(
  homedir(),
  ".joelclaw/slack-thread-sessions.json",
);
export const DEFAULT_SLACK_THREAD_QUIET_TIMEOUT_MS = 30 * 60_000;

export type SlackThreadSessionStatus =
  | "neutral"
  | "bound"
  | "running"
  | "resolving"
  | "retired";

export type SlackThreadSession = {
  readonly threadId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly threadTs: string;
  readonly status: SlackThreadSessionStatus;
  readonly binding?: SlackChannelContextBinding;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly paneId?: string;
  readonly workspaceId?: string;
  readonly plannedSessionId?: string;
  readonly plannedWorkspaceLabel?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastHumanMessageAt: string;
  readonly resolvedAt?: string;
  readonly retireAfter?: string;
  readonly currentTurn?: {
    readonly sourceEventId: string;
    readonly state: "claimed" | "launched" | "completed" | "delivered";
    readonly updatedAt: string;
  };
};

type SlackThreadSessionFile = {
  readonly version: 1;
  readonly sessions: Readonly<Record<string, SlackThreadSession>>;
};

export const slackThreadSessionMachine = createMachine({
  id: "slackThreadSession",
  initial: "neutral",
  states: {
    neutral: {
      on: {
        BIND: "bound",
        START: "running",
        RESOLVE: "resolving",
      },
    },
    bound: {
      on: {
        START: "running",
        RESOLVE: "resolving",
      },
    },
    running: {
      on: {
        SETTLE_BOUND: "bound",
        SETTLE_NEUTRAL: "neutral",
        RESOLVE: "resolving",
      },
    },
    resolving: {
      on: {
        HUMAN_REPLY_BOUND: "bound",
        HUMAN_REPLY_NEUTRAL: "neutral",
        RETIRE: "retired",
      },
    },
    retired: { type: "final" },
  },
});

function threadId(channelId: string, threadTs: string): string {
  return `slack:${channelId}:${threadTs}`;
}

function machineState(status: SlackThreadSessionStatus): string {
  return status;
}

function transitionStatus(
  status: SlackThreadSessionStatus,
  event: "BIND" | "START" | "SETTLE_BOUND" | "SETTLE_NEUTRAL" | "RESOLVE" | "HUMAN_REPLY_BOUND" | "HUMAN_REPLY_NEUTRAL" | "RETIRE",
): SlackThreadSessionStatus {
  const actor = createActor(slackThreadSessionMachine, {
    snapshot: slackThreadSessionMachine.resolveState({
      value: machineState(status),
      context: {},
    }),
  }).start();
  actor.send({ type: event });
  const next = String(actor.getSnapshot().value) as SlackThreadSessionStatus;
  actor.stop();
  return next;
}

function bindingRoot(binding: SlackChannelContextBinding | undefined): string | undefined {
  return binding?.cwd?.trim() || binding?.repo?.trim();
}

async function verifiedBinding(
  binding: SlackChannelContextBinding | undefined,
): Promise<SlackChannelContextBinding | undefined> {
  const root = bindingRoot(binding);
  if (!root || !isAbsolute(root)) return undefined;
  try {
    if (!(await stat(root)).isDirectory()) return undefined;
    if (binding?.brainEntry) {
      await stat(resolve(root, binding.brainEntry));
    }
    return binding;
  } catch {
    return undefined;
  }
}

async function readFileState(path: string): Promise<SlackThreadSessionFile> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as SlackThreadSessionFile;
    return {
      version: 1,
      sessions: value?.sessions && typeof value.sessions === "object"
        ? value.sessions
        : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, sessions: {} };
    }
    throw error;
  }
}

async function writeFileState(
  path: string,
  sessions: Readonly<Record<string, SlackThreadSession>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const rawPid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
    if (!Number.isSafeInteger(rawPid) || rawPid < 1) {
      await rm(lockPath, { force: true });
      return true;
    }
    try {
      process.kill(rawPid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      await rm(lockPath, { force: true });
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() - started > 10_000) {
        throw new Error(`Timed out acquiring Slack thread session lock ${lockPath}`);
      }
      await wait(25);
    }
  }
  try {
    return await run();
  } finally {
    await rm(lockPath, { force: true });
  }
}

export class SlackThreadSessionRegistry {
  constructor(
    private readonly path = process.env.SLACK_SHITRAT_THREAD_SESSIONS_PATH?.trim()
      || DEFAULT_SLACK_THREAD_SESSIONS_PATH,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(channelId: string, threadTs: string): Promise<SlackThreadSession | undefined> {
    return (await readFileState(this.path)).sessions[threadId(channelId, threadTs)];
  }

  async listActive(): Promise<SlackThreadSession[]> {
    const sessions = Object.values((await readFileState(this.path)).sessions);
    return sessions.filter((session) => session.status !== "retired");
  }

  async activate(input: {
    readonly channelId: string;
    readonly channelName: string;
    readonly threadTs: string;
    readonly binding?: SlackChannelContextBinding;
  }): Promise<SlackThreadSession> {
    const now = this.now().toISOString();
    const verified = await verifiedBinding(input.binding);
    const current = await this.get(input.channelId, input.threadTs);
    if (current && current.status !== "retired") {
      return this.update(current.threadId, {
        channelName: input.channelName,
        lastHumanMessageAt: now,
        updatedAt: now,
        ...(verified && !current.binding ? {
          binding: verified,
          status: transitionStatus(current.status, "BIND"),
        } : {}),
      });
    }
    const id = threadId(input.channelId, input.threadTs);
    const session: SlackThreadSession = {
      threadId: id,
      channelId: input.channelId,
      channelName: input.channelName,
      threadTs: input.threadTs,
      status: verified ? "bound" : "neutral",
      ...(verified ? { binding: verified } : {}),
      createdAt: now,
      updatedAt: now,
      lastHumanMessageAt: now,
    };
    return this.update(id, session);
  }

  async noteHumanReply(
    channelId: string,
    threadTs: string,
  ): Promise<SlackThreadSession | undefined> {
    const current = await this.get(channelId, threadTs);
    if (!current || current.status === "retired") return undefined;
    const now = this.now().toISOString();
    const status = current.status === "resolving"
      ? transitionStatus(
          current.status,
          current.binding ? "HUMAN_REPLY_BOUND" : "HUMAN_REPLY_NEUTRAL",
        )
      : current.status;
    return this.update(current.threadId, {
      status,
      updatedAt: now,
      lastHumanMessageAt: now,
      resolvedAt: undefined,
      retireAfter: undefined,
    });
  }

  async claimTurn(input: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly sourceEventId: string;
  }): Promise<{ readonly claimed: boolean; readonly session: SlackThreadSession }> {
    const current = await this.get(input.channelId, input.threadTs);
    if (!current) throw new Error(`No Slack thread session for ${input.channelId}:${input.threadTs}`);
    return withFileLock(this.path, async () => {
      const state = await readFileState(this.path);
      const fresh = state.sessions[current.threadId];
      if (!fresh) throw new Error(`No Slack thread session for ${input.channelId}:${input.threadTs}`);
      if (fresh.currentTurn?.sourceEventId === input.sourceEventId) {
        return { claimed: false, session: fresh };
      }
      if (
        fresh.currentTurn?.state === "claimed"
        || fresh.currentTurn?.state === "launched"
      ) {
        throw new Error(
          `Slack thread session ${fresh.threadId} already has turn ${fresh.currentTurn.sourceEventId} in flight`,
        );
      }
      const now = this.now().toISOString();
      const session = {
        ...fresh,
        currentTurn: {
          sourceEventId: input.sourceEventId,
          state: "claimed" as const,
          updatedAt: now,
        },
        updatedAt: now,
      };
      await writeFileState(this.path, { ...state.sessions, [fresh.threadId]: session });
      return { claimed: true, session };
    });
  }

  async markTurnLaunched(
    channelId: string,
    threadTs: string,
    sourceEventId: string,
  ): Promise<SlackThreadSession> {
    const current = await this.get(channelId, threadTs);
    if (!current || current.currentTurn?.sourceEventId !== sourceEventId) {
      throw new Error(`No claimed Slack thread turn ${sourceEventId}`);
    }
    const now = this.now().toISOString();
    return this.update(current.threadId, {
      currentTurn: { sourceEventId, state: "launched", updatedAt: now },
      updatedAt: now,
    });
  }

  async completeTurn(
    channelId: string,
    threadTs: string,
    sourceEventId: string,
  ): Promise<SlackThreadSession> {
    const current = await this.get(channelId, threadTs);
    if (!current || current.currentTurn?.sourceEventId !== sourceEventId) {
      throw new Error(`No claimed Slack thread turn ${sourceEventId}`);
    }
    const now = this.now().toISOString();
    return this.update(current.threadId, {
      currentTurn: { sourceEventId, state: "completed", updatedAt: now },
      updatedAt: now,
    });
  }

  async attachPlan(input: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly plannedSessionId: string;
    readonly plannedWorkspaceLabel: string;
  }): Promise<SlackThreadSession> {
    const current = await this.get(input.channelId, input.threadTs);
    if (!current) throw new Error(`No Slack thread session for ${input.channelId}:${input.threadTs}`);
    return this.update(current.threadId, {
      plannedSessionId: input.plannedSessionId,
      plannedWorkspaceLabel: input.plannedWorkspaceLabel,
      updatedAt: this.now().toISOString(),
    });
  }

  async attachRuntime(input: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly sessionId: string;
    readonly sessionFile?: string;
    readonly paneId?: string;
    readonly workspaceId?: string;
  }): Promise<SlackThreadSession> {
    const current = await this.get(input.channelId, input.threadTs);
    if (!current) throw new Error(`No Slack thread session for ${input.channelId}:${input.threadTs}`);
    return this.update(current.threadId, {
      status: transitionStatus(current.status, "START"),
      sessionId: input.sessionId,
      sessionFile: input.sessionFile,
      paneId: input.paneId,
      workspaceId: input.workspaceId,
      updatedAt: this.now().toISOString(),
    });
  }

  async settle(channelId: string, threadTs: string): Promise<SlackThreadSession> {
    const current = await this.get(channelId, threadTs);
    if (!current) throw new Error(`No Slack thread session for ${channelId}:${threadTs}`);
    return this.update(current.threadId, {
      status: transitionStatus(
        current.status,
        current.binding ? "SETTLE_BOUND" : "SETTLE_NEUTRAL",
      ),
      updatedAt: this.now().toISOString(),
    });
  }

  async resolve(
    channelId: string,
    threadTs: string,
    quietTimeoutMs = DEFAULT_SLACK_THREAD_QUIET_TIMEOUT_MS,
  ): Promise<SlackThreadSession> {
    const current = await this.get(channelId, threadTs);
    if (!current) throw new Error(`No Slack thread session for ${channelId}:${threadTs}`);
    const now = this.now();
    return this.update(current.threadId, {
      status: transitionStatus(current.status, "RESOLVE"),
      resolvedAt: now.toISOString(),
      retireAfter: new Date(now.getTime() + quietTimeoutMs).toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  async retireDue(): Promise<SlackThreadSession[]> {
    return withFileLock(this.path, async () => {
      const state = await readFileState(this.path);
      const nowMs = this.now().getTime();
      const retired: SlackThreadSession[] = [];
      const sessions = { ...state.sessions };
      for (const [id, session] of Object.entries(sessions)) {
        if (
          session.status !== "resolving"
          || !session.retireAfter
          || Date.parse(session.retireAfter) > nowMs
        ) continue;
        const next = {
          ...session,
          status: transitionStatus(session.status, "RETIRE"),
          updatedAt: this.now().toISOString(),
        } as SlackThreadSession;
        sessions[id] = next;
        retired.push(next);
      }
      if (retired.length > 0) await writeFileState(this.path, sessions);
      return retired;
    });
  }

  private async update(
    id: string,
    patch: Partial<SlackThreadSession>,
  ): Promise<SlackThreadSession> {
    return withFileLock(this.path, async () => {
      const state = await readFileState(this.path);
      const current = state.sessions[id];
      const next = { ...current, ...patch } as SlackThreadSession;
      await writeFileState(this.path, { ...state.sessions, [id]: next });
      return next;
    });
  }

}
