/**
 * Headless T3 Code session over the typed WebSocket contract.
 *
 * Effect v4 stays inside this file; the exported surface is plain promises and
 * async iterables so Effect-3 joelclaw code (and the gateway session) can use
 * it without touching v4 types. Verified against T3 contracts 0.0.33.
 */

import { randomUUID } from "node:crypto";
import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
} from "@joelclaw/t3-contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { issueSocketUrl, type T3Credentials } from "./credentials.ts";
import type {
  ApprovalDecision,
  GatewayEvent,
  ProjectSummary,
  ShellSnapshot,
  ThreadSummary,
} from "./events.ts";

export interface StartTurnInput {
  readonly prompt: string;
  /** Find-or-create a project rooted here. Exactly one of workspaceRoot | projectId. */
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly title?: string;
  /** Defaults to the project's default selection, else the most recent thread's. */
  readonly modelInstanceId?: string;
  readonly model?: string;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly interactionMode?: "default" | "plan";
}

export interface StartTurnResult {
  readonly threadId: string;
  readonly projectId: string;
  readonly modelInstanceId: string;
  readonly model: string;
}

export interface T3Session {
  shellSnapshot(): Promise<ShellSnapshot>;
  startTurn(input: StartTurnInput): Promise<StartTurnResult>;
  /** Streams normalized events; ends after turn-settled when untilSettled. */
  watchThread(threadId: string, options?: { untilSettled?: boolean }): AsyncIterable<GatewayEvent>;
  respondApproval(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  respondUserInput(threadId: string, requestId: string, answers: unknown): Promise<void>;
  interruptTurn(threadId: string): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  close(): Promise<void>;
}

const nowIso = () => new Date().toISOString();

/** Minimal push queue bridging Effect streams to AsyncIterable. */
function asyncQueue<T>() {
  const values: Array<T> = [];
  let done = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const signal = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push(value: T) {
      values.push(value);
      signal();
    },
    end() {
      done = true;
      signal();
    },
    fail(error: unknown) {
      failure = error;
      done = true;
      signal();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (values.length > 0) yield values.shift()!;
        if (done) {
          if (failure !== undefined) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

function toThreadSummary(thread: any): ThreadSummary {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelInstanceId: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    turnState: thread.latestTurn?.state ?? null,
    hasPendingApprovals: thread.hasPendingApprovals === true,
    hasPendingUserInput: thread.hasPendingUserInput === true,
    updatedAt: thread.updatedAt,
  };
}

function toProjectSummary(project: any): ProjectSummary {
  return {
    projectId: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
  };
}

export async function connectT3(credentials: T3Credentials): Promise<T3Session> {
  const socketUrl = await issueSocketUrl(credentials);

  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(socketUrl, { openTimeout: "15 seconds" }).pipe(
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
        ),
        RpcSerialization.layerJson,
      ),
    ),
  );

  const scope = await Effect.runPromise(Scope.make());
  const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
  let context: Awaited<ReturnType<typeof buildContext>>;
  async function buildContext() {
    return await run(Layer.buildWithScope(protocolLayer, scope));
  }
  try {
    context = await buildContext();
  } catch (error) {
    await run(Scope.close(scope, Exit.succeed(undefined)));
    throw error;
  }
  const client: any = await run(
    RpcClient.make(WsRpcGroup).pipe(Effect.provide(context), Scope.provide(scope)),
  );

  // Connection health probe: fail fast if the socket never came up.
  await run(client[WS_METHODS.serverGetConfig]({}).pipe(Effect.timeout("20 seconds")));

  const dispatch = (command: Record<string, unknown>) =>
    run(
      client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        commandId: randomUUID(),
        createdAt: nowIso(),
        ...command,
      }),
    );

  const shellSnapshot = async (): Promise<ShellSnapshot> => {
    const first: any = await run(
      client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
        Stream.filter((item: any) => item.kind === "snapshot"),
        Stream.take(1),
        Stream.runHead,
        Effect.timeout("20 seconds"),
      ),
    );
    const snapshot = (first?.value ?? first)?.snapshot;
    if (!snapshot) throw new Error("no shell snapshot received");
    return {
      projects: snapshot.projects.map(toProjectSummary),
      threads: snapshot.threads.map(toThreadSummary),
    };
  };

  const rawShellSnapshot = async (): Promise<any> => {
    const first: any = await run(
      client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
        Stream.filter((item: any) => item.kind === "snapshot"),
        Stream.take(1),
        Stream.runHead,
        Effect.timeout("20 seconds"),
      ),
    );
    return (first?.value ?? first)?.snapshot;
  };

  const startTurn = async (input: StartTurnInput): Promise<StartTurnResult> => {
    if (!input.prompt.trim()) throw new Error("prompt must not be empty");
    if (!input.workspaceRoot && !input.projectId) {
      throw new Error("startTurn needs workspaceRoot or projectId");
    }
    const snapshot = await rawShellSnapshot();

    let project = input.projectId
      ? snapshot.projects.find((p: any) => p.id === input.projectId)
      : snapshot.projects.find((p: any) => p.workspaceRoot === input.workspaceRoot);
    if (!project && input.projectId) throw new Error(`unknown projectId ${input.projectId}`);
    if (!project) {
      const projectId = randomUUID();
      await dispatch({
        type: "project.create",
        projectId,
        title: input.title ?? input.workspaceRoot!,
        workspaceRoot: input.workspaceRoot!,
        createWorkspaceRootIfMissing: true,
      });
      project = { id: projectId, defaultModelSelection: null };
    }

    const projectThreads = [...snapshot.threads]
      .filter((t: any) => t.projectId === project.id)
      .sort((a: any, b: any) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const recentAny = [...snapshot.threads].sort((a: any, b: any) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt)),
    );
    const modelSelection =
      input.modelInstanceId && input.model
        ? { instanceId: input.modelInstanceId, model: input.model }
        : (project.defaultModelSelection ??
          projectThreads[0]?.modelSelection ??
          recentAny[0]?.modelSelection);
    if (!modelSelection) {
      throw new Error(
        "no model selection available: pass modelInstanceId + model (no project default or prior thread to borrow from)",
      );
    }

    const threadId = randomUUID();
    const runtimeMode = input.runtimeMode ?? "approval-required";
    const interactionMode = input.interactionMode ?? "default";
    await dispatch({
      type: "thread.turn.start",
      threadId,
      message: { messageId: randomUUID(), role: "user", text: input.prompt, attachments: [] },
      modelSelection,
      runtimeMode,
      interactionMode,
      bootstrap: {
        createThread: {
          projectId: project.id,
          title: input.title ?? input.prompt.slice(0, 60),
          modelSelection,
          runtimeMode,
          interactionMode,
          branch: null,
          worktreePath: null,
          createdAt: nowIso(),
        },
      },
    });
    return {
      threadId,
      projectId: project.id,
      modelInstanceId: modelSelection.instanceId,
      model: modelSelection.model,
    };
  };

  const watchThread = (
    threadId: string,
    options?: { untilSettled?: boolean },
  ): AsyncIterable<GatewayEvent> => {
    const queue = asyncQueue<GatewayEvent>();
    let assistantText = "";

    const threadEvents = client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
      Stream.runForEach((item: any) =>
        Effect.sync(() => {
          if (item.kind === "snapshot") {
            queue.push({ kind: "sync", threadId });
            return;
          }
          if (item.kind !== "event") return;
          const event = item.event;
          switch (event.type) {
            case "thread.message-sent": {
              const text = String(event.payload.text ?? "");
              if (event.payload.role === "assistant" && text.length > 0) assistantText = text;
              queue.push({
                kind: "message",
                threadId,
                role: event.payload.role,
                text,
                streaming: event.payload.streaming === true,
              });
              return;
            }
            case "thread.activity-appended": {
              const activity = event.payload.activity;
              const kindText = String(activity.kind);
              queue.push({
                kind: "activity",
                threadId,
                activityKind: kindText,
                tone: String(activity.tone),
                summary: String(activity.summary),
                payload: activity.payload,
              });
              if (/approval/i.test(kindText)) {
                queue.push({
                  kind: "attention",
                  threadId,
                  reason: "approval",
                  summary: String(activity.summary),
                  payload: activity.payload,
                });
              } else if (/user-input|question/i.test(kindText)) {
                queue.push({
                  kind: "attention",
                  threadId,
                  reason: "user-input",
                  summary: String(activity.summary),
                  payload: activity.payload,
                });
              }
              return;
            }
            default:
              queue.push({ kind: "event", threadId, type: String(event.type) });
          }
        }),
      ),
    );

    // Turn settlement is authoritative on the shell stream.
    const settled = client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
      Stream.filter(
        (item: any) =>
          item.kind === "thread-upserted" &&
          item.thread.id === threadId &&
          item.thread.latestTurn != null &&
          item.thread.latestTurn.state !== "running",
      ),
      Stream.take(1),
      Stream.runHead,
      // Let trailing thread events (the final message frame) drain first so
      // turn-settled is the last event a consumer sees.
      Effect.tap(() => Effect.sleep("500 millis")),
      Effect.map((head: any) => {
        const turn = (head?.value ?? head)?.thread?.latestTurn;
        queue.push({
          kind: "turn-settled",
          threadId,
          state: turn?.state ?? "error",
          assistantText: assistantText.trim(),
        });
      }),
    );

    const program = options?.untilSettled === false
      ? Effect.all([threadEvents, settled], { concurrency: 2 })
      : Effect.raceFirst(threadEvents, settled);

    const fiber = Effect.runFork(
      (program as Effect.Effect<unknown, unknown, never>).pipe(
        Effect.matchCauseEffect({
          onSuccess: () => Effect.sync(() => queue.end()),
          onFailure: (cause) => Effect.sync(() => queue.fail(new Error(String(cause)))),
        }),
      ),
    );
    const iterable = queue[Symbol.asyncIterator].bind(queue);
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = iterable();
        const originalReturn = iterator.return?.bind(iterator);
        iterator.return = async (value?: unknown) => {
          Effect.runFork(Fiber.interrupt(fiber));
          return originalReturn ? originalReturn(value) : { done: true, value: undefined };
        };
        return iterator;
      },
    };
  };

  return {
    shellSnapshot,
    startTurn,
    watchThread,
    respondApproval: async (threadId, requestId, decision) => {
      await dispatch({ type: "thread.approval.respond", threadId, requestId, decision });
    },
    respondUserInput: async (threadId, requestId, answers) => {
      await dispatch({ type: "thread.user-input.respond", threadId, requestId, answers });
    },
    interruptTurn: async (threadId) => {
      await dispatch({ type: "thread.turn.interrupt", threadId });
    },
    stopSession: async (threadId) => {
      await dispatch({ type: "thread.session.stop", threadId });
    },
    close: async () => {
      await run(Scope.close(scope, Exit.succeed(undefined)));
    },
  };
}

/**
 * Reconnect wrapper for daemon use: (re)connects with capped exponential
 * backoff and hands each live session to `use`. Returns only if `use` returns
 * without the connection dying.
 */
export async function withReconnect(
  credentials: T3Credentials,
  use: (session: T3Session) => Promise<void>,
  options?: { maxDelayMs?: number; onRetry?: (error: unknown, delayMs: number) => void },
): Promise<void> {
  const maxDelay = options?.maxDelayMs ?? 30_000;
  let delay = 1000;
  for (;;) {
    let session: T3Session | undefined;
    try {
      session = await connectT3(credentials);
      delay = 1000;
      await use(session);
      return;
    } catch (error) {
      options?.onRetry?.(error, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelay);
    } finally {
      await session?.close().catch(() => {});
    }
  }
}
