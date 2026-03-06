import { createHash } from "node:crypto";
import { ack, drainByPriority, getUnacked, indexMessagesByPriority, type Priority, persist } from "@joelclaw/message-store";
import { emitGatewayOtel } from "@joelclaw/telemetry";

export type QueueEntry = {
  source: string;
  prompt: string;
  enqueuedAt: number;
  enqueueOrder: number;
  replyTo?: string;
  metadata?: Record<string, unknown>;
  streamId?: string;
  priority?: Priority;
  supersessionKey?: string;
  /** ADR-0209: Thread ID for this message */
  threadId?: string;
  /** ADR-0209: Channel anchor to reply-to on outbound */
  replyToAnchor?: string;
};

export interface ActiveRequest {
  id: string;
  source: string;
  enqueuedAt: number;
  enqueueOrder: number;
  prompt: string;
  supersessionKey?: string;
  supersededAt?: number;
  supersededBySource?: string;
  /** ADR-0209: Thread ID for this turn */
  threadId?: string;
  /** ADR-0209: Channel anchor for outbound reply-to */
  replyToAnchor?: string;
}

export type SupersessionEvent = {
  source: string;
  supersessionKey: string;
  enqueuedAt: number;
  enqueueOrder: number;
  droppedQueued: number;
  abortRequested: boolean;
  activeRequestId?: string;
};

export type SupersessionState = {
  activeRequest: {
    id: string;
    source: string;
    enqueuedAt: string;
    supersessionKey: string | null;
    superseded: boolean;
    supersededAt: string | null;
    supersededBySource: string | null;
  } | null;
  lastEvent: {
    source: string;
    supersessionKey: string;
    enqueuedAt: string;
    droppedQueued: number;
    abortRequested: boolean;
    activeRequestId: string | null;
  } | null;
};

type PromptSession = {
  prompt: (text: string) => unknown | Promise<unknown>;
  reload: () => Promise<void>;
  compact: (customInstructions?: string) => Promise<unknown>;
  /** Force a new session, optionally injecting a compression summary as the first message. */
  newSession: (compressionSummary?: string) => Promise<void>;
};

type PromptCallback = () => void;
type IdleWaiter = () => Promise<void>;
export type QueueErrorEvent = {
  consecutiveFailures: number;
  source: string;
  error: string;
};
export type EnqueueResult = {
  streamId?: string;
  priority?: Priority;
  supersession?: SupersessionEvent;
};
type ErrorCallback = (event: QueueErrorEvent) => void | Promise<void> | Promise<boolean>;
type SupersessionCallback = (event: SupersessionEvent) => void | Promise<void>;
/** Called before new session creation. Returns a compression summary to seed the fresh session. */
type ContextOverflowCallback = () => Promise<string>;

const queue: QueueEntry[] = [];
let sessionRef: PromptSession | undefined;
let drainPromise: Promise<void> | undefined;
let onPromptSent: PromptCallback | undefined;
let onPromptError: ErrorCallback | undefined;
let onSupersessionRequested: SupersessionCallback | undefined;
let onContextOverflow: ContextOverflowCallback | undefined;
let idleWaiter: IdleWaiter | undefined;
let consecutiveFailures = 0;
let contextOverflowCount = 0;
let activeRequest: ActiveRequest | undefined;
let lastSupersessionEvent: SupersessionEvent | undefined;
const latestSupersessionByKey = new Map<string, { enqueuedAt: number; enqueueOrder: number }>();
let enqueueOrderCounter = 0;

/**
 * Detect "prompt is too long" errors from the API.
 * These are unrecoverable without compaction or new session —
 * model fallback won't help.
 */
function isContextOverflowError(error: unknown): boolean {
  const msg = typeof error === "object" && error !== null && "message" in error
    ? String((error as any).message)
    : String(error);
  return msg.includes("prompt is too long") || msg.includes("maximum context length");
}

function streamIdToTimestamp(streamId: string | undefined, fallbackTs: number): number {
  if (!streamId) return fallbackTs;
  const first = streamId.split("-")[0];
  const parsed = Number.parseInt(first ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallbackTs;
}

function nextEnqueueOrder(): number {
  enqueueOrderCounter += 1;
  return enqueueOrderCounter;
}

function getSupersessionKey(source: string, metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) return undefined;

  const explicit = metadata.gatewaySupersessionKey;
  if (typeof explicit === "string") {
    const normalized = explicit.trim();
    if (normalized.length > 0) return normalized;
  }

  return metadata.gatewayHumanLatestWins === true ? source : undefined;
}

function getPersistedEnqueueOrder(metadata: Record<string, unknown> | undefined, fallbackOrder: number): number {
  const value = metadata?.gatewayEnqueueOrder;
  return typeof value === "number" && Number.isFinite(value) ? value : fallbackOrder;
}

async function dropQueuedEntriesForSupersession(
  supersessionKey: string,
  enqueueOrder: number,
): Promise<number> {
  const dropped = queue.filter((entry) =>
    entry.supersessionKey === supersessionKey && entry.enqueueOrder < enqueueOrder,
  );
  if (dropped.length === 0) return 0;

  const kept = queue.filter((entry) =>
    !(entry.supersessionKey === supersessionKey && entry.enqueueOrder < enqueueOrder),
  );
  queue.length = 0;
  queue.push(...kept);

  await Promise.all(dropped.map(async (entry) => {
    if (entry.streamId) {
      await ack(entry.streamId);
    }
  }));

  return dropped.length;
}

export function setSession(session: PromptSession): void {
  sessionRef = session;
}

export function reloadSession(): Promise<void> {
  if (!sessionRef) throw new Error("No session");
  return sessionRef.reload();
}

export function compactSession(instructions?: string): Promise<unknown> {
  if (!sessionRef) throw new Error("No session");
  return sessionRef.compact(instructions);
}

export function newSession(): Promise<void> {
  if (!sessionRef) throw new Error("No session");
  return sessionRef.newSession();
}

/** Register a callback fired each time a prompt is dispatched to the session. */
export function onPrompt(cb: PromptCallback): void {
  onPromptSent = cb;
}

/** Register a callback fired when a prompt fails. Receives source, error text, and consecutive failure count. */
export function onError(cb: ErrorCallback): void {
  onPromptError = cb;
}

/** Register a callback fired when a newer human message supersedes the active turn. */
export function onSupersession(cb: SupersessionCallback): void {
  onSupersessionRequested = cb;
}

/** Register a callback fired on context overflow (prompt too long). Called AFTER auto-recovery attempts. */
export function onContextOverflowRecovery(cb: ContextOverflowCallback): void {
  onContextOverflow = cb;
}

export function getConsecutiveOverflows(): number {
  return contextOverflowCount;
}

/**
 * Register a function that returns a Promise resolving when the session
 * is idle (turn finished). Called after each prompt() to prevent the drain
 * loop from firing the next message while the agent is still streaming.
 *
 * session.prompt() resolves when the message is *queued*, not when the
 * full turn completes. Without this gate, back-to-back messages race
 * and hit "Agent is already processing".
 */
export function setIdleWaiter(fn: IdleWaiter): void {
  idleWaiter = fn;
}

export async function enqueue(
  source: string,
  prompt: string,
  metadata?: Record<string, unknown>,
  options?: { streamId?: string; threadId?: string; replyToAnchor?: string },
): Promise<EnqueueResult> {
  let streamId = options?.streamId;
  let priority: Priority | undefined;
  const supersessionKey = getSupersessionKey(source, metadata);
  const enqueueOrder = nextEnqueueOrder();
  const queueMetadata = supersessionKey
    ? { ...(metadata ?? {}), gatewayEnqueueOrder: enqueueOrder }
    : metadata;
  let supersession: SupersessionEvent | undefined;

  if (!streamId) {
    try {
      const persisted = await persist({ source, prompt, metadata: queueMetadata });
      if (!persisted) {
        const { normalizedBody, strippedInjectedContext } = normalizePromptForDedup(prompt);
        const dedupDigest = createHash("sha256").update(normalizedBody).digest("hex");
        void emitGatewayOtel({
          level: "debug",
          component: "command-queue",
          action: "queue.dedup_dropped",
          success: true,
          metadata: {
            source,
            dedupLayer: "message-store",
            dedupHashPrefix: dedupDigest.slice(0, 12),
            promptLength: prompt.length,
            normalizedLength: normalizedBody.length,
            strippedInjectedContext,
          },
        });
        return {};
      }
      streamId = persisted.streamId;
      priority = persisted.priority;
    } catch (error) {
      console.error("[gateway:store] persist failed; enqueueing without durable stream id", {
        source,
        error,
      });
      void emitGatewayOtel({
        level: "warn",
        component: "command-queue",
        action: "queue.persist.failed",
        success: false,
        error: String(error),
        metadata: { source },
      });
    }
  }

  const enqueuedAt = streamIdToTimestamp(streamId, Date.now());

  if (supersessionKey) {
    const droppedQueued = await dropQueuedEntriesForSupersession(supersessionKey, enqueueOrder);
    latestSupersessionByKey.set(supersessionKey, { enqueuedAt, enqueueOrder });

    const activeMatches = activeRequest?.supersessionKey === supersessionKey
      && activeRequest.enqueueOrder < enqueueOrder;
    if (activeMatches && activeRequest) {
      activeRequest.supersededAt = enqueuedAt;
      activeRequest.supersededBySource = source;
    }

    supersession = {
      source,
      supersessionKey,
      enqueuedAt,
      enqueueOrder,
      droppedQueued,
      abortRequested: Boolean(activeMatches),
      activeRequestId: activeMatches ? activeRequest?.id : undefined,
    };
    lastSupersessionEvent = supersession;

    void emitGatewayOtel({
      level: "info",
      component: "command-queue",
      action: "queue.supersession.requested",
      success: true,
      metadata: {
        source,
        supersessionKey,
        droppedQueued,
        abortRequested: Boolean(activeMatches),
      },
    });

    if (activeMatches) {
      try {
        await onSupersessionRequested?.(supersession);
      } catch (error) {
        console.error("command-queue: supersession callback failed", {
          source,
          supersessionKey,
          error,
        });
        void emitGatewayOtel({
          level: "error",
          component: "command-queue",
          action: "queue.supersession.callback_failed",
          success: false,
          error: String(error),
          metadata: {
            source,
            supersessionKey,
            activeRequestId: activeRequest?.id,
          },
        });
      }
    }
  }

  // Durable messages are drained from the Redis priority layer. Keep local queue
  // only for fallback messages when persistence is unavailable.
  if (!options?.streamId && streamId) {
    void emitGatewayOtel({
      level: "debug",
      component: "command-queue",
      action: "queue.enqueued",
      success: true,
      metadata: {
        source,
        depth: queue.length,
        hasStreamId: true,
        ...(priority !== undefined ? { priority } : {}),
        ...(supersessionKey ? { supersessionKey } : {}),
      },
    });
    return { streamId, priority, supersession };
  }

  queue.push({
    source,
    prompt,
    enqueuedAt,
    enqueueOrder,
    metadata: queueMetadata,
    streamId,
    priority,
    supersessionKey,
    threadId: options?.threadId,
    replyToAnchor: options?.replyToAnchor,
  });
  void emitGatewayOtel({
    level: "debug",
    component: "command-queue",
    action: "queue.enqueued",
    success: true,
    metadata: {
      source,
      depth: queue.length,
      hasStreamId: Boolean(streamId),
      ...(priority !== undefined ? { priority } : {}),
      ...(supersessionKey ? { supersessionKey } : {}),
    },
  });
  if (queue.length >= 20) {
    void emitGatewayOtel({
      level: "warn",
      component: "command-queue",
      action: "queue.backpressure",
      success: false,
      metadata: {
        depth: queue.length,
      },
    });
  }

  return { streamId, priority, supersession };
}

export function getActiveSource(): string | undefined {
  return activeRequest?.source;
}

/** ADR-0209: Get active thread context for outbound routing */
export function getActiveThreadContext(): { threadId?: string; replyToAnchor?: string } | undefined {
  if (!activeRequest) return undefined;
  return {
    threadId: activeRequest.threadId,
    replyToAnchor: activeRequest.replyToAnchor,
  };
}

export function isActiveRequestSuperseded(): boolean {
  return Boolean(activeRequest?.supersededAt);
}

export function getSupersessionState(): SupersessionState {
  return {
    activeRequest: activeRequest
      ? {
          id: activeRequest.id,
          source: activeRequest.source,
          enqueuedAt: new Date(activeRequest.enqueuedAt).toISOString(),
          supersessionKey: activeRequest.supersessionKey ?? null,
          superseded: Boolean(activeRequest.supersededAt),
          supersededAt: activeRequest.supersededAt ? new Date(activeRequest.supersededAt).toISOString() : null,
          supersededBySource: activeRequest.supersededBySource ?? null,
        }
      : null,
    lastEvent: lastSupersessionEvent
      ? {
          source: lastSupersessionEvent.source,
          supersessionKey: lastSupersessionEvent.supersessionKey,
          enqueuedAt: new Date(lastSupersessionEvent.enqueuedAt).toISOString(),
          droppedQueued: lastSupersessionEvent.droppedQueued,
          abortRequested: lastSupersessionEvent.abortRequested,
          activeRequestId: lastSupersessionEvent.activeRequestId ?? null,
        }
      : null,
  };
}

/** @deprecated Use getActiveSource() instead. */
export function getCurrentSource(): string | undefined {
  return getActiveSource();
}

export function getQueueDepth(): number {
  return queue.length;
}

export function getConsecutiveFailures(): number {
  return consecutiveFailures;
}

export function resetFailureCount(): void {
  consecutiveFailures = 0;
}

// ── Consecutive duplicate detection ──────────────────────
// Tracks recent prompts to drop consecutive identical messages from the
// same source. Catches duplicates that slip past the persist-layer dedup
// (e.g. 31s apart, replayed on restart, or race conditions).
const DEDUP_RING_SIZE = 10;
const DEDUP_WINDOW_MS = 120_000; // 2 minutes
type DedupEntry = { hash: string; source: string; ts: number };
const dedupRing: DedupEntry[] = [];

function stripInjectedChannelContext(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("---\nChannel:")) {
    return trimmed;
  }

  const contextEnd = trimmed.indexOf("\n---\n", 4);
  if (contextEnd === -1) {
    return trimmed;
  }

  const body = trimmed.slice(contextEnd + "\n---\n".length).trim();
  return body || trimmed;
}

function normalizePromptForDedup(prompt: string): {
  normalizedBody: string;
  strippedInjectedContext: boolean;
} {
  const trimmed = prompt.trim();
  const stripped = stripInjectedChannelContext(prompt);
  return {
    normalizedBody: stripped.replace(/\s+/g, " ").trim(),
    strippedInjectedContext: stripped !== trimmed,
  };
}

function contentHash(source: string, prompt: string): string {
  // Dedup should be based on semantic message body, not the injected channel preamble.
  // The preamble contains mostly static formatting and minute-level timestamps.
  const { normalizedBody } = normalizePromptForDedup(prompt);
  const digest = createHash("sha256").update(normalizedBody).digest("hex");
  return `${source}::${digest}`;
}

function isDuplicateConsecutive(source: string, prompt: string): boolean {
  const hash = contentHash(source, prompt);
  const now = Date.now();

  // Prune expired entries
  while (dedupRing.length > 0 && now - dedupRing[0]!.ts > DEDUP_WINDOW_MS) {
    dedupRing.shift();
  }

  // Check if this exact content was recently processed from the same source
  const isDup = dedupRing.some((e) => e.hash === hash);

  if (!isDup) {
    dedupRing.push({ hash, source, ts: now });
    if (dedupRing.length > DEDUP_RING_SIZE) dedupRing.shift();
  }

  return isDup;
}

async function dequeue(failedStreamIds: Set<string>): Promise<QueueEntry | null> {
  if (activeRequest) return null;

  const localEntry = queue.shift();
  if (localEntry) return localEntry;

  let next: Awaited<ReturnType<typeof drainByPriority>>;
  try {
    next = await drainByPriority({ limit: 1, excludeIds: failedStreamIds });
  } catch (error) {
    const message = String(error);
    if (message.includes("redis client not initialized")) {
      return null;
    }
    throw error;
  }

  const message = next[0];
  if (!message) return null;

  return {
    source: message.source,
    prompt: message.prompt,
    enqueuedAt: message.timestamp,
    enqueueOrder: getPersistedEnqueueOrder(message.metadata, nextEnqueueOrder()),
    metadata: message.metadata,
    streamId: message.id,
    priority: message.priority,
    supersessionKey: getSupersessionKey(message.source, message.metadata),
  };
}

export async function drain(): Promise<void> {
  if (drainPromise) return drainPromise;

  drainPromise = (async () => {
    const failedStreamIds = new Set<string>();

    while (true) {
      const entry = await dequeue(failedStreamIds);
      if (!entry) break;

      if (entry.supersessionKey) {
        const latestSupersession = latestSupersessionByKey.get(entry.supersessionKey);
        const superseded = latestSupersession && (
          entry.enqueuedAt < latestSupersession.enqueuedAt
          || (entry.enqueuedAt === latestSupersession.enqueuedAt && entry.enqueueOrder < latestSupersession.enqueueOrder)
        );
        if (superseded && latestSupersession) {
          console.log("[command-queue] dropped superseded entry", {
            source: entry.source,
            supersessionKey: entry.supersessionKey,
            streamId: entry.streamId,
          });
          void emitGatewayOtel({
            level: "info",
            component: "command-queue",
            action: "queue.superseded_dropped",
            success: true,
            metadata: {
              source: entry.source,
              supersessionKey: entry.supersessionKey,
              streamId: entry.streamId,
              enqueuedAt: new Date(entry.enqueuedAt).toISOString(),
              supersededByAt: new Date(latestSupersession.enqueuedAt).toISOString(),
              supersededByOrder: latestSupersession.enqueueOrder,
            },
          });
          if (entry.streamId) {
            await ack(entry.streamId);
          }
          continue;
        }
      }

      // Drop consecutive duplicates — same source + same content within 2min window
      if (isDuplicateConsecutive(entry.source, entry.prompt)) {
        const { normalizedBody, strippedInjectedContext } = normalizePromptForDedup(entry.prompt);
        const dedupDigest = createHash("sha256").update(normalizedBody).digest("hex");

        console.log("[command-queue] dropped consecutive duplicate", {
          source: entry.source,
          streamId: entry.streamId,
          promptPreview: entry.prompt.slice(0, 60),
        });
        void emitGatewayOtel({
          level: "info",
          component: "command-queue",
          action: "queue.consecutive_dedup_dropped",
          success: true,
          metadata: {
            source: entry.source,
            streamId: entry.streamId,
            dedupLayer: "consecutive-ring",
            dedupHashPrefix: dedupDigest.slice(0, 12),
            promptLength: entry.prompt.length,
            normalizedLength: normalizedBody.length,
            strippedInjectedContext,
          },
        });
        if (entry.streamId) await ack(entry.streamId);
        continue;
      }

      activeRequest = {
        id: crypto.randomUUID(),
        source: entry.source,
        enqueuedAt: entry.enqueuedAt,
        enqueueOrder: entry.enqueueOrder,
        prompt: entry.prompt,
        supersessionKey: entry.supersessionKey,
        threadId: entry.threadId,
        replyToAnchor: entry.replyToAnchor,
      };
      const startedAt = Date.now();

      try {
        if (!sessionRef) {
          console.error("command-queue: no prompt session set; dropping queued prompt", {
            source: entry.source,
          });
          void emitGatewayOtel({
            level: "error",
            component: "command-queue",
            action: "queue.session_missing",
            success: false,
            error: "no_prompt_session_set",
            metadata: { source: entry.source },
          });
          continue;
        }

        // Set up idle waiter BEFORE prompt() so turn_end can resolve it
        // regardless of when prompt() returns. If prompt() blocks until
        // turn_end, the idle promise is already resolved by the time we
        // await it. If prompt() returns early, we correctly wait.
        const idlePromise = idleWaiter?.();

        // Retry loop: pi SDK throws "Agent is already processing" if
        // isStreaming hasn't cleared yet after turn_end. Small delay
        // between retries gives the session time to settle.
        const MAX_PROMPT_RETRIES = 3;
        const RETRY_DELAY_MS = 2000;
        let promptSent = false;
        for (let attempt = 0; attempt < MAX_PROMPT_RETRIES; attempt++) {
          try {
            await sessionRef.prompt(entry.prompt);
            onPromptSent?.();
            promptSent = true;
            break;
          } catch (retryError: any) {
            const isStreamingRace = typeof retryError?.message === "string"
              && retryError.message.includes("already processing");
            if (!isStreamingRace || attempt >= MAX_PROMPT_RETRIES - 1) {
              throw retryError; // not a race, or exhausted retries
            }
            console.warn("command-queue: session still streaming, retrying", {
              attempt: attempt + 1,
              source: entry.source,
              delayMs: RETRY_DELAY_MS,
            });
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          }
        }
        if (!promptSent) throw new Error("prompt retries exhausted");

        if (idlePromise) {
          await idlePromise;
        }

        if (entry.streamId) {
          await ack(entry.streamId);
        }

        consecutiveFailures = 0;
        void emitGatewayOtel({
          level: "debug",
          component: "command-queue",
          action: "queue.prompt.sent",
          success: true,
          duration_ms: Date.now() - startedAt,
          metadata: {
            source: entry.source,
            depthAfterSend: queue.length,
            ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
          },
        });
      } catch (error) {
        // ── Context overflow recovery ─────────────────────────────
        // "prompt is too long" is unrecoverable via model fallback.
        // Strategy: compact → retry → if still overflowing → new session → replay.
        if (isContextOverflowError(error) && sessionRef) {
          contextOverflowCount += 1;
          console.warn("command-queue: context overflow detected", {
            source: entry.source,
            overflowCount: contextOverflowCount,
          });
          void emitGatewayOtel({
            level: "error",
            component: "command-queue",
            action: "queue.context_overflow.detected",
            success: false,
            error: String(error),
            metadata: { source: entry.source, overflowCount: contextOverflowCount },
          });

          try {
            if (contextOverflowCount === 1) {
              // First overflow: try aggressive compaction
              console.log("command-queue: attempting compaction to recover from context overflow");
              await sessionRef.compact("CRITICAL: Context exceeded model limit. Aggressively summarize all history. Keep only essential context.");
              // Re-enqueue the failed message at front so it retries immediately
              queue.unshift(entry);
              if (entry.streamId) failedStreamIds.delete(entry.streamId);
              void emitGatewayOtel({
                level: "info",
                component: "command-queue",
                action: "queue.context_overflow.compacted",
                success: true,
                metadata: { source: entry.source },
              });
            } else {
              // Compaction wasn't enough (or repeated overflow). Nuclear option: new session.
              console.warn("command-queue: compaction insufficient — forcing new session", {
                overflowCount: contextOverflowCount,
              });
              // Build compression summary from the dying session before we nuke it
              let compressionSummary: string | undefined;
              try {
                compressionSummary = await onContextOverflow?.();
              } catch (summaryErr) {
                console.error("command-queue: compression summary generation failed", { summaryErr });
              }
              await sessionRef.newSession(compressionSummary);
              contextOverflowCount = 0;
              // Re-enqueue the failed message at front
              queue.unshift(entry);
              if (entry.streamId) failedStreamIds.delete(entry.streamId);
              void emitGatewayOtel({
                level: "warn",
                component: "command-queue",
                action: "queue.context_overflow.new_session",
                success: true,
                metadata: {
                  source: entry.source,
                  hasSummary: !!compressionSummary,
                  summaryLength: compressionSummary?.length ?? 0,
                },
              });
            }
          } catch (recoveryError) {
            console.error("command-queue: context overflow recovery failed", {
              recoveryError,
              source: entry.source,
            });
            if (entry.streamId) failedStreamIds.add(entry.streamId);
            void emitGatewayOtel({
              level: "fatal",
              component: "command-queue",
              action: "queue.context_overflow.recovery_failed",
              success: false,
              error: String(recoveryError),
              metadata: { source: entry.source },
            });
          }
          // Skip the normal error path — overflow is handled above
        } else {
        // ── Normal error path ─────────────────────────────────────
        if (entry.streamId) failedStreamIds.add(entry.streamId);
        consecutiveFailures += 1;
        contextOverflowCount = 0; // reset overflow counter on non-overflow errors
        const errorText = error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
        console.error("command-queue: prompt failed", {
          source: entry.source,
          consecutiveFailures,
          error,
        });
        // Notify fallback controller (may trigger model swap)
        try {
          await onPromptError?.({
            consecutiveFailures,
            source: entry.source,
            error: errorText,
          });
        } catch {
          /* swallow */
        }
        void emitGatewayOtel({
          level: consecutiveFailures >= 3 ? "fatal" : "error",
          component: "command-queue",
          action: "queue.prompt.failed",
          success: false,
          duration_ms: Date.now() - startedAt,
          error: errorText,
          metadata: {
            source: entry.source,
            consecutiveFailures,
            depthAfterFailure: queue.length,
            ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
          },
        });
        } // end normal error path
      } finally {
        activeRequest = undefined;
      }
    }
  })().finally(() => {
    drainPromise = undefined;
  });

  return drainPromise;
}

/**
 * Replay unacked messages on startup — only recent ones.
 * Age filtering happens inside getUnacked() — stale messages are
 * acked at the store level so they never surface again.
 */
export async function replayUnacked(): Promise<void> {
  try {
    // getUnacked() handles age filtering and acks stale messages internally.
    // Reindex replayable messages into the priority set for ordered draining.
    const replayable = await getUnacked();
    if (replayable.length === 0) {
      console.log("[gateway:store] no messages to replay on startup");
      void emitGatewayOtel({
        level: "debug",
        component: "command-queue",
        action: "queue.replay.empty",
        success: true,
      });
      return;
    }

    const indexed = await indexMessagesByPriority(replayable);

    console.log("[gateway:store] replayed unacked messages into priority queue", {
      count: replayable.length,
      indexed,
    });
    void emitGatewayOtel({
      level: "info",
      component: "command-queue",
      action: "queue.replay.completed",
      success: true,
      metadata: {
        replayCount: replayable.length,
        indexedCount: indexed,
      },
    });
  } catch (error) {
    console.error("[gateway:store] replay failed", { error });
    void emitGatewayOtel({
      level: "error",
      component: "command-queue",
      action: "queue.replay.failed",
      success: false,
      error: String(error),
    });
    return;
  }

  await drain();
}

export const __commandQueueTestUtils = {
  stripInjectedChannelContext,
  contentHash,
  resetState(): void {
    queue.length = 0;
    sessionRef = undefined;
    drainPromise = undefined;
    onPromptSent = undefined;
    onPromptError = undefined;
    onSupersessionRequested = undefined;
    onContextOverflow = undefined;
    idleWaiter = undefined;
    consecutiveFailures = 0;
    contextOverflowCount = 0;
    activeRequest = undefined;
    lastSupersessionEvent = undefined;
    latestSupersessionByKey.clear();
    enqueueOrderCounter = 0;
    dedupRing.length = 0;
  },
};
