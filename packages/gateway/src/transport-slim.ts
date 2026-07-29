import type {
  AppendMessageEventInput,
  AppendMessageEventReceipt,
  MessageEventOrigin,
  MessagePlatform,
} from "@joelclaw/message-event-log";
import type { JournalEventInput } from "@joelclaw/message-journal";
import type { AdapterPostableMessage } from "chat";

export type SdkPostableMessage = AdapterPostableMessage;

export interface SdkDeliveryAdapter {
  readonly openDM: (userId: string) => Promise<string>;
  readonly postMessage: (
    threadId: string,
    message: SdkPostableMessage,
  ) => Promise<{ readonly id: string; readonly threadId: string; readonly raw?: unknown }>;
}

export const GATEWAY_AGENT_HEARTBEAT_KEY = "gateway:agent:heartbeat" as const;
export const FALLBACK_PREFIX = "⚠️ fallback:" as const;
export type FallbackChannel = "telegram" | "sms";

/** Driver TTL default — used only as a reporting floor when absence has no prior present sample. */
export const DEFAULT_HEARTBEAT_TTL_MS = 60_000;
/**
 * Blip grace before fallback.
 *
 * The driver refreshes every 15s with a 60s TTL. A single missing poll during a
 * normal session cycle is not an outage — require the key to stay gone across a
 * recheck after this grace before dumping raw text at Joel. Real outages still
 * fall back after one grace window (~20s), which is prompt enough and keeps the
 * kill drill green (it already waits a full TTL before probing).
 */
export const DEFAULT_HEARTBEAT_BLIP_GRACE_MS = 20_000;
/** Rolling outage batch window. The first fallback still sends immediately. */
export const DEFAULT_FALLBACK_COALESCE_MS = 10 * 60_000;
export const FALLBACK_SUBJECT_MAX = 140;

export interface MessageEventAppender {
  readonly append: (
    input: AppendMessageEventInput,
  ) => Promise<AppendMessageEventReceipt>;
}

export interface JournalPort {
  readonly record: (input: JournalEventInput) => Promise<{ readonly persisted: boolean }>;
}

export interface ProducerFacts {
  readonly eventId: string;
  readonly source: string;
  readonly text: string;
  readonly flowId: string;
  readonly occurredAt: number;
  readonly origin: MessageEventOrigin;
  readonly evidence: Record<string, unknown>;
}

export interface ExplicitTransportSendRequest {
  readonly target: {
    readonly platform: MessagePlatform;
    readonly recipientId: string;
  };
  readonly content: SdkPostableMessage;
  readonly text: string;
  readonly flowId: string;
  readonly origin: MessageEventOrigin;
  readonly correlationId?: string;
  readonly replyThreadId?: string;
}

export interface ExplicitTransportSendReceipt {
  readonly flowId: string;
  readonly platform: MessagePlatform;
  readonly platformMessageId: string;
  readonly threadId: string;
}

export interface RawFallbackRequest {
  readonly text: string;
  readonly flowId: string;
  readonly sourceEventId: string;
  readonly origin: MessageEventOrigin;
  readonly heartbeatObservedAt: number;
  /** Measured age of heartbeat evidence at decision time — not the TTL constant. */
  readonly heartbeatStaleForMs: number;
  readonly heartbeatGateReason?: string;
  /** Every producer input represented by this physical Telegram send. */
  readonly receipts?: readonly RawFallbackReceipt[];
  readonly sourceCounts?: Readonly<Record<string, number>>;
}

export interface RawFallbackReceipt {
  readonly sourceEventId: string;
  readonly flowId: string;
  readonly source: string;
  readonly origin: MessageEventOrigin;
  readonly heartbeatObservedAt: number;
  readonly heartbeatStaleForMs: number;
  readonly heartbeatGateReason?: string;
}

/** One observation of agent-liveness evidence. Prefer GET+checkedAt over bare EXISTS. */
export interface HeartbeatProbeSample {
  readonly present: boolean;
  /** Driver payload `checkedAt` when the key is present and parseable. */
  readonly checkedAt?: number;
}

export type HeartbeatGateReason =
  | "present"
  | "blip-recovered"
  | "blip-pending"
  | "stale"
  | "confirmed-absent";

export interface HeartbeatAssessment {
  readonly alive: boolean;
  readonly staleForMs: number;
  readonly observedAt: number;
  readonly reason: HeartbeatGateReason;
  readonly rechecked: boolean;
}

/** Mutable gate memory shared across ingress calls in one transport process. */
export interface HeartbeatGateState {
  lastPresentAt?: number;
  lastCheckedAt?: number;
  confirmedAbsentSince?: number;
  fallbackOutageActive: boolean;
  fallbackBatch?: PendingFallbackBatch;
}

export function createHeartbeatGateState(): HeartbeatGateState {
  return { fallbackOutageActive: false };
}

export interface FallbackBatchScheduleHandle {
  readonly cancel: () => void;
}

export type ScheduleFallbackBatch = (
  task: () => Promise<void>,
  delayMs: number,
) => FallbackBatchScheduleHandle;

interface PendingFallbackMember extends RawFallbackReceipt {
  readonly urgentSubject?: string;
}

interface PendingFallbackBatch {
  readonly members: PendingFallbackMember[];
  schedule?: FallbackBatchScheduleHandle;
}

export interface SlimNotifyIngressDependencies {
  readonly eventLog: MessageEventAppender;
  /**
   * Preferred probe. Return key presence plus optional driver `checkedAt`.
   * Falls back to wrapping `heartbeatExists` when omitted.
   */
  readonly probeHeartbeat?: () => Promise<HeartbeatProbeSample>;
  /** @deprecated Prefer probeHeartbeat — retained for thin boolean adapters. */
  readonly heartbeatExists?: () => Promise<boolean>;
  readonly fallbackChannel: FallbackChannel;
  readonly sendRawTelegramFallback: (
    input: RawFallbackRequest,
  ) => Promise<ExplicitTransportSendReceipt>;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
  readonly heartbeatTtlMs?: number;
  readonly blipGraceMs?: number;
  readonly coalesceWindowMs?: number;
  readonly scheduleFallbackBatch?: ScheduleFallbackBatch;
  readonly onFallbackBatchError?: (error: unknown) => void;
  /** Process-local gate memory. Create once per transport process. */
  readonly gateState?: HeartbeatGateState;
}

export class RawFallbackDeliveryError extends Error {
  constructor(
    readonly crossedPlatformBoundary: boolean,
    override readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`${crossedPlatformBoundary
      ? "Fallback delivery is ambiguous after the platform boundary"
      : "Fallback delivery failed before the platform boundary"}${detail}`);
    this.name = "RawFallbackDeliveryError";
  }
}

export class SlimIngressStageError extends Error {
  constructor(
    readonly stage: "append" | "heartbeat" | "fallback",
    override readonly cause: unknown,
  ) {
    super(`Slim transport ingress failed at ${stage}`);
    this.name = "SlimIngressStageError";
  }
}

export type SlimNotifyIngressResult =
  | {
      readonly disposition: "agent";
      readonly sourceEventId: string;
      readonly flowId: string;
      readonly heartbeatStaleForMs?: number;
      readonly heartbeatGateReason?: HeartbeatGateReason;
    }
  | {
      readonly disposition: "fallback";
      readonly sourceEventId: string;
      readonly flowId: string;
      readonly platformMessageId: string;
      readonly heartbeatStaleForMs: number;
      readonly heartbeatGateReason: HeartbeatGateReason;
    }
  | {
      readonly disposition: "held";
      readonly sourceEventId: string;
      readonly flowId: string;
      readonly heartbeatStaleForMs: number;
      readonly heartbeatGateReason: HeartbeatGateReason;
      readonly heldCount: number;
    };

const PRIVATE_FALLBACK_SOURCE_PATTERN =
  /(?:^|[./:_-])(front|email|slack)(?:$|[./:_-])/i;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function fallbackEvidenceRecords(facts: ProducerFacts): readonly Record<string, unknown>[] {
  return [
    facts.evidence,
    recordValue(facts.evidence.evidence),
    recordValue(facts.evidence.context),
    recordValue(facts.evidence.data),
  ].filter((value): value is Record<string, unknown> => value !== undefined);
}

function fallbackSourceCandidates(facts: ProducerFacts): readonly string[] {
  const records = fallbackEvidenceRecords(facts);
  return [
    facts.source,
    facts.origin.producer,
    ...records.flatMap((record) => [
      typeof record.source === "string" ? record.source : "",
      typeof record.sourceFunction === "string" ? record.sourceFunction : "",
      typeof record.kind === "string" ? record.kind : "",
      typeof record.type === "string" ? record.type : "",
    ]),
  ];
}

/** Front, email, and Slack producer paths can carry private human bodies. */
export function isPrivateFallbackProducer(facts: ProducerFacts): boolean {
  return fallbackSourceCandidates(facts)
    .some((value) => PRIVATE_FALLBACK_SOURCE_PATTERN.test(value));
}

function fallbackPriority(facts: ProducerFacts): string | undefined {
  for (const record of fallbackEvidenceRecords(facts)) {
    for (const field of ["priority", "severity", "urgency"] as const) {
      const value = record[field];
      if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
    }
  }
  return undefined;
}

function cleanFallbackSubject(value: string): string | undefined {
  const firstLine = value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  const stripped = firstLine
    .replace(/^#+\s*/u, "")
    .replace(/^[-*]\s+/u, "")
    .trim();
  if (!stripped) return undefined;
  return stripped.length > FALLBACK_SUBJECT_MAX
    ? `${stripped.slice(0, FALLBACK_SUBJECT_MAX - 1)}…`
    : stripped;
}

function urgentFallbackSubject(facts: ProducerFacts): string | undefined {
  if (isPrivateFallbackProducer(facts)) return undefined;
  const priority = fallbackPriority(facts);
  if (priority !== "urgent" && priority !== "critical") return undefined;
  for (const record of fallbackEvidenceRecords(facts)) {
    for (const field of ["subject", "title"] as const) {
      const value = record[field];
      if (typeof value === "string") {
        const subject = cleanFallbackSubject(value);
        if (subject) return subject;
      }
    }
  }
  return cleanFallbackSubject(facts.text);
}

export function parseHeartbeatPayload(raw: string | null | undefined): HeartbeatProbeSample {
  if (raw == null || raw === "") return { present: false };
  try {
    const parsed = JSON.parse(raw) as { checkedAt?: unknown };
    const checkedAt = typeof parsed.checkedAt === "number" && Number.isFinite(parsed.checkedAt)
      ? parsed.checkedAt
      : undefined;
    return checkedAt === undefined ? { present: true } : { present: true, checkedAt };
  } catch {
    return { present: true };
  }
}

/** Redis GET-based probe — richer than EXISTS and yields measured checkedAt. */
export function makeRedisHeartbeatProbe(
  get: (key: string) => Promise<string | null>,
): () => Promise<HeartbeatProbeSample> {
  return async () => parseHeartbeatPayload(await get(GATEWAY_AGENT_HEARTBEAT_KEY));
}

function renderFallbackSummary(members: readonly PendingFallbackMember[]): string {
  const counts = new Map<string, number>();
  for (const member of members) {
    counts.set(member.source, (counts.get(member.source) ?? 0) + 1);
  }
  const sources = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, count]) => `${source} × ${count}`)
    .join(", ");
  const subjects = [...new Set(
    members.flatMap((member) =>
      member.urgentSubject ? [`${member.source}: ${member.urgentSubject}`] : []
    ),
  )];
  const count = members.length;
  return [
    `gateway unreachable — ${count} ${count === 1 ? "message" : "messages"} held`,
    `Sources: ${sources}`,
    ...(subjects.length > 0
      ? ["Urgent/critical subjects:", ...subjects.map((subject) => `- ${subject}`)]
      : []),
  ].join("\n");
}

/** Privacy-safe fallback body. Raw producer text never crosses this boundary. */
export function formatFallbackText(facts: ProducerFacts): string {
  return renderFallbackSummary([{
    sourceEventId: facts.eventId,
    flowId: facts.flowId,
    source: facts.source,
    origin: facts.origin,
    heartbeatObservedAt: facts.occurredAt,
    heartbeatStaleForMs: 0,
    urgentSubject: urgentFallbackSubject(facts),
  }]);
}

function resolveProbe(
  dependencies: SlimNotifyIngressDependencies,
): () => Promise<HeartbeatProbeSample> {
  if (dependencies.probeHeartbeat) return dependencies.probeHeartbeat;
  if (dependencies.heartbeatExists) {
    return async () => ({ present: await dependencies.heartbeatExists!() });
  }
  throw new Error("probeHeartbeat or heartbeatExists is required");
}

/**
 * Decide whether the agent loop is alive enough to own the message.
 *
 * Absent evidence triggers one recheck after blipGraceMs unless this process
 * already confirmed absence. Secondary transport files (last-heartbeat.ts,
 * gateway.pid) are intentionally NOT used as alive signals — they prove the
 * transport process, not the agent loop, and would re-create the circularity
 * the kill drill exists to catch.
 */
export async function assessHeartbeatGate(input: {
  readonly probe: () => Promise<HeartbeatProbeSample>;
  readonly state: HeartbeatGateState;
  readonly now: () => number;
  readonly blipGraceMs: number;
  readonly heartbeatTtlMs: number;
  readonly wait: (ms: number) => Promise<void>;
}): Promise<HeartbeatAssessment> {
  const { probe, state, now, blipGraceMs, heartbeatTtlMs, wait } = input;
  const firstAt = now();
  const first = await probe();

  if (first.present) {
    state.lastPresentAt = firstAt;
    if (first.checkedAt !== undefined) state.lastCheckedAt = first.checkedAt;
    state.confirmedAbsentSince = undefined;
    const staleForMs = first.checkedAt !== undefined
      ? Math.max(0, firstAt - first.checkedAt)
      : 0;
    return {
      alive: true,
      staleForMs,
      observedAt: firstAt,
      reason: "present",
      rechecked: false,
    };
  }

  // Already confirmed dead in this process — fail open to fallback without another sleep.
  if (state.confirmedAbsentSince !== undefined) {
    return {
      alive: false,
      staleForMs: Math.max(0, firstAt - state.confirmedAbsentSince),
      observedAt: firstAt,
      reason: "confirmed-absent",
      rechecked: false,
    };
  }

  // Blip tolerance: one recheck after grace. A momentary missing key must not
  // dump raw text; a still-missing key after grace is a real outage path.
  await wait(blipGraceMs);
  const observedAt = now();
  const second = await probe();

  if (second.present) {
    state.lastPresentAt = observedAt;
    if (second.checkedAt !== undefined) state.lastCheckedAt = second.checkedAt;
    state.confirmedAbsentSince = undefined;
    const staleForMs = second.checkedAt !== undefined
      ? Math.max(0, observedAt - second.checkedAt)
      : Math.max(0, observedAt - firstAt);
    return {
      alive: true,
      staleForMs,
      observedAt,
      reason: "blip-recovered",
      rechecked: true,
    };
  }

  state.confirmedAbsentSince = firstAt;
  const measuredGap = Math.max(0, observedAt - firstAt);
  const sincePresent = state.lastPresentAt !== undefined
    ? Math.max(0, observedAt - state.lastPresentAt)
    : undefined;
  const staleForMs = sincePresent !== undefined
    ? Math.max(measuredGap, sincePresent)
    : Math.max(measuredGap, heartbeatTtlMs);

  return {
    alive: false,
    staleForMs,
    observedAt,
    reason: "stale",
    rechecked: true,
  };
}

function numericTelegramId(value: string): number | null {
  const candidate = Number(value.split(":").at(-1));
  return Number.isSafeInteger(candidate) ? candidate : null;
}

function originSystemId(origin: MessageEventOrigin): string {
  return origin.sessionId ?? origin.paneId ?? origin.machineId;
}

function journalInput(input: {
  readonly request: ExplicitTransportSendRequest;
  readonly eventType: "message.outbound.requested" | "message.outbound.confirmed" | "message.outbound.failed";
  readonly deliveryState: "requested" | "confirmed" | "failed";
  readonly platformMessageId?: string;
  readonly threadId?: string;
  readonly errorCode?: string;
}): JournalEventInput {
  const { request } = input;
  const telegramChatId = request.target.platform === "telegram"
    ? (numericTelegramId(request.target.recipientId) ?? 0)
    : 0;
  const telegramMessageId = request.target.platform === "telegram" && input.platformMessageId
    ? numericTelegramId(input.platformMessageId)
    : null;
  return {
    messageKey: `${request.target.platform}:${request.flowId}:${input.eventType}`,
    flowId: request.flowId,
    channel: request.target.platform,
    direction: "outbound",
    eventType: input.eventType,
    producer: request.origin.producer,
    originSystemId: originSystemId(request.origin),
    sourceEventId: request.correlationId ?? null,
    sourceRef: request.correlationId ?? "",
    route: "explicit-agent-target",
    telegramChatId,
    telegramMessageId,
    text: request.text,
    transportText: request.text,
    deliveryState: input.deliveryState,
    errorCode: input.errorCode,
    metadata: {
      target: request.target,
      threadId: input.threadId,
      origin: request.origin,
      correlationId: request.correlationId,
    },
  };
}

/**
 * The gateway agent must choose the target and author the postable content.
 * This sender performs platform mechanics only; no kind or route table exists here.
 */
export function makeExplicitTransportSender(dependencies: {
  readonly adapters: Partial<Record<MessagePlatform, SdkDeliveryAdapter>>;
  readonly journal: JournalPort;
  readonly eventLog: MessageEventAppender;
  readonly rememberFlow?: (receipt: ExplicitTransportSendReceipt) => Promise<void>;
}) {
  return async function send(
    request: ExplicitTransportSendRequest,
  ): Promise<ExplicitTransportSendReceipt> {
    const adapter = dependencies.adapters[request.target.platform];
    if (!adapter) {
      throw new Error(`Transport adapter unavailable: ${request.target.platform}`);
    }

    await dependencies.eventLog.append({
      semanticKey: `delivery-requested:${request.flowId}`,
      kind: "delivery.requested",
      source: "gateway-agent",
      flowId: request.flowId,
      origin: request.origin,
      correlationId: request.correlationId,
      platform: request.target.platform,
      payload: {
        target: request.target,
        content: request.content,
      },
    });
    await dependencies.journal.record(journalInput({
      request,
      eventType: "message.outbound.requested",
      deliveryState: "requested",
    }));

    try {
      const threadId = request.replyThreadId
        ?? await adapter.openDM(request.target.recipientId);
      const sent = await adapter.postMessage(threadId, request.content);
      const platformMessageId = sent.id.trim();
      if (!platformMessageId) {
        throw new Error(`${request.target.platform} adapter returned no platform message id`);
      }
      const resolvedThreadId = sent.threadId.trim() || threadId;
      const journalReceipt = await dependencies.journal.record(journalInput({
        request,
        eventType: "message.outbound.confirmed",
        deliveryState: "confirmed",
        platformMessageId,
        threadId: resolvedThreadId,
      }));
      if (!journalReceipt.persisted) {
        throw new Error("Platform send succeeded but its journal receipt was not persisted");
      }
      const receipt: ExplicitTransportSendReceipt = {
        flowId: request.flowId,
        platform: request.target.platform,
        platformMessageId,
        threadId: resolvedThreadId,
      };
      await dependencies.rememberFlow?.(receipt);
      await dependencies.eventLog.append({
        semanticKey: `delivery-confirmed:${request.flowId}:${platformMessageId}`,
        kind: "delivery.confirmed",
        source: "gateway-transport",
        flowId: request.flowId,
        origin: request.origin,
        correlationId: request.correlationId,
        platform: request.target.platform,
        platformMessageId,
        payload: { threadId: resolvedThreadId },
      });
      return receipt;
    } catch (cause) {
      await dependencies.journal.record(journalInput({
        request,
        eventType: "message.outbound.failed",
        deliveryState: "failed",
        errorCode: "MESSAGE_DELIVERY_FAILED",
      }));
      throw cause;
    }
  };
}

/**
 * Fallback is deliberately separate from the ordinary sender. It reaches the
 * owned Telegram adapter directly and cannot inherit routing or formatting policy.
 */
export function makeRawTelegramFallbackSender(dependencies: {
  readonly adapter: SdkDeliveryAdapter;
  readonly recipientId: string;
  readonly journal: JournalPort;
  readonly eventLog: MessageEventAppender;
}) {
  return async function sendRawTelegramFallback(
    input: RawFallbackRequest,
  ): Promise<ExplicitTransportSendReceipt> {
    const transportText = `${FALLBACK_PREFIX} ${input.text}`;
    const request: ExplicitTransportSendRequest = {
      target: { platform: "telegram", recipientId: dependencies.recipientId },
      content: { raw: transportText },
      text: transportText,
      flowId: input.flowId,
      origin: input.origin,
      correlationId: input.sourceEventId,
    };
    const threadId = await dependencies.adapter.openDM(dependencies.recipientId).catch((error) => {
      throw new RawFallbackDeliveryError(false, error);
    });
    const sent = await dependencies.adapter.postMessage(threadId, request.content).catch((error) => {
      // The adapter can fail after Telegram accepted the request. Never retry
      // this ambiguous send automatically.
      throw new RawFallbackDeliveryError(true, error);
    });
    const platformMessageId = sent.id.trim();
    if (!platformMessageId) {
      throw new RawFallbackDeliveryError(
        true,
        new Error("Telegram fallback adapter returned no platform message id"),
      );
    }
    const resolvedThreadId = sent.threadId.trim() || threadId;

    // Send first. If this persistence boundary is ambiguous, throw and do not
    // retry here: the recovered gateway agent reconciles the stream.
    const journalReceipt = await dependencies.journal.record(journalInput({
      request,
      eventType: "message.outbound.confirmed",
      deliveryState: "confirmed",
      platformMessageId,
      threadId: resolvedThreadId,
    })).catch((error) => {
      throw new RawFallbackDeliveryError(true, error);
    });
    if (!journalReceipt.persisted) {
      throw new RawFallbackDeliveryError(
        true,
        new Error("Fallback sent but its journal receipt was not persisted; automatic retry forbidden"),
      );
    }
    const receipts = input.receipts ?? [{
      sourceEventId: input.sourceEventId,
      flowId: input.flowId,
      source: input.origin.producer,
      origin: input.origin,
      heartbeatObservedAt: input.heartbeatObservedAt,
      heartbeatStaleForMs: input.heartbeatStaleForMs,
      heartbeatGateReason: input.heartbeatGateReason,
    }];
    for (const receipt of receipts) {
      await dependencies.eventLog.append({
        semanticKey: `fallback-delivered:${receipt.sourceEventId}:${platformMessageId}`,
        kind: "fallback.delivered",
        source: "gateway-transport",
        flowId: receipt.flowId,
        origin: receipt.origin,
        correlationId: receipt.sourceEventId,
        platform: "telegram",
        platformMessageId,
        payload: {
          sourceEventId: receipt.sourceEventId,
          producerSource: receipt.source,
          fallback: true,
          heldCount: receipts.length,
          sourceCounts: input.sourceCounts,
          heartbeatObservedAt: receipt.heartbeatObservedAt,
          heartbeatStaleForMs: receipt.heartbeatStaleForMs,
          ...(receipt.heartbeatGateReason
            ? { heartbeatGateReason: receipt.heartbeatGateReason }
            : {}),
          platformMessageId,
          outcome: receipts.length === 1 ? "confirmed" : "batch-confirmed",
        },
      }).catch((error) => {
        throw new RawFallbackDeliveryError(true, error);
      });
    }
    return {
      flowId: input.flowId,
      platform: "telegram",
      platformMessageId,
      threadId: resolvedThreadId,
    };
  };
}

/** Append first, then decide with a measured heartbeat gate (not bare EXISTS). */
export function makeSlimNotifyIngress(
  dependencies: SlimNotifyIngressDependencies,
) {
  const probe = resolveProbe(dependencies);
  const gateState = dependencies.gateState ?? createHeartbeatGateState();
  const heartbeatTtlMs = dependencies.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  const blipGraceMs = dependencies.blipGraceMs ?? DEFAULT_HEARTBEAT_BLIP_GRACE_MS;
  const coalesceWindowMs = dependencies.coalesceWindowMs ?? DEFAULT_FALLBACK_COALESCE_MS;
  const nowFn = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));
  const onFallbackBatchError = dependencies.onFallbackBatchError
    ?? ((error: unknown) => console.error("[gateway:transport] fallback batch failed", {
      error: String(error),
    }));
  const scheduleFallbackBatch = dependencies.scheduleFallbackBatch
    ?? ((task: () => Promise<void>, delayMs: number): FallbackBatchScheduleHandle => {
      const timer = setTimeout(() => {
        void task().catch(onFallbackBatchError);
      }, delayMs);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    });

  const resetFallbackOutage = () => {
    gateState.fallbackBatch?.schedule?.cancel();
    gateState.fallbackBatch = undefined;
    gateState.fallbackOutageActive = false;
  };

  const sourceCountsFor = (
    members: readonly PendingFallbackMember[],
  ): Readonly<Record<string, number>> => {
    const counts: Record<string, number> = {};
    for (const member of members) {
      counts[member.source] = (counts[member.source] ?? 0) + 1;
    }
    return counts;
  };

  const sendFallbackMembers = async (
    members: readonly PendingFallbackMember[],
  ): Promise<ExplicitTransportSendReceipt> => {
    const representative = members[0];
    if (!representative) throw new Error("Cannot send an empty fallback batch");
    return dependencies.sendRawTelegramFallback({
      text: renderFallbackSummary(members),
      flowId: representative.flowId,
      sourceEventId: representative.sourceEventId,
      origin: representative.origin,
      heartbeatObservedAt: representative.heartbeatObservedAt,
      heartbeatStaleForMs: representative.heartbeatStaleForMs,
      heartbeatGateReason: representative.heartbeatGateReason,
      receipts: members,
      sourceCounts: sourceCountsFor(members),
    });
  };

  const schedulePendingBatch = (batch: PendingFallbackBatch) => {
    batch.schedule?.cancel();
    batch.schedule = scheduleFallbackBatch(async () => {
      if (gateState.fallbackBatch !== batch) return;

      // A recovered gateway owns the canonical message.requested events. Do not
      // claim fallback delivery or send a stale outage summary after recovery.
      const heartbeat = await probe();
      const observedAt = nowFn();
      if (heartbeat.present) {
        gateState.lastPresentAt = observedAt;
        if (heartbeat.checkedAt !== undefined) gateState.lastCheckedAt = heartbeat.checkedAt;
        gateState.confirmedAbsentSince = undefined;
        resetFallbackOutage();
        return;
      }

      gateState.fallbackBatch = undefined;
      await sendFallbackMembers(batch.members);
    }, coalesceWindowMs);
  };

  return async function ingest(
    facts: ProducerFacts,
  ): Promise<SlimNotifyIngressResult> {
    const appended = await dependencies.eventLog.append({
      semanticKey: `producer:${facts.eventId}`,
      kind: "message.requested",
      source: facts.source,
      flowId: facts.flowId,
      origin: facts.origin,
      correlationId: `${facts.source}:${facts.eventId}`,
      rawSourceId: facts.eventId,
      occurredAt: facts.occurredAt,
      payload: {
        text: facts.text,
        evidence: facts.evidence,
      },
    }).catch((error) => {
      throw new SlimIngressStageError("append", error);
    });

    const assessment = await assessHeartbeatGate({
      probe,
      state: gateState,
      now: nowFn,
      blipGraceMs,
      heartbeatTtlMs,
      wait,
    }).catch((error) => {
      throw new SlimIngressStageError("heartbeat", error);
    });

    if (assessment.alive) {
      resetFallbackOutage();
      return {
        disposition: "agent",
        sourceEventId: appended.eventId,
        flowId: facts.flowId,
        heartbeatStaleForMs: assessment.staleForMs,
        heartbeatGateReason: assessment.reason,
      };
    }

    // The only other conditional is the static deploy-time channel selector.
    if (dependencies.fallbackChannel !== "telegram") {
      throw new SlimIngressStageError(
        "fallback",
        new Error("FALLBACK_CHANNEL=sms is not implemented; keep telegram until its adapter ships"),
      );
    }

    const observedAt = assessment.observedAt;
    const member: PendingFallbackMember = {
      sourceEventId: appended.eventId,
      flowId: facts.flowId,
      source: facts.source,
      origin: facts.origin,
      heartbeatObservedAt: observedAt,
      heartbeatStaleForMs: assessment.staleForMs,
      heartbeatGateReason: assessment.reason,
      urgentSubject: urgentFallbackSubject(facts),
    };

    if (gateState.fallbackOutageActive) {
      const batch = gateState.fallbackBatch ?? { members: [] };
      batch.members.push(member);
      gateState.fallbackBatch = batch;
      schedulePendingBatch(batch);
      return {
        disposition: "held",
        sourceEventId: appended.eventId,
        flowId: facts.flowId,
        heartbeatStaleForMs: assessment.staleForMs,
        heartbeatGateReason: assessment.reason,
        heldCount: batch.members.length,
      };
    }

    const receipt = await sendFallbackMembers([member])
      .catch((error) => {
        resetFallbackOutage();
        throw new SlimIngressStageError("fallback", error);
      });
    gateState.fallbackOutageActive = true;

    return {
      disposition: "fallback",
      sourceEventId: appended.eventId,
      flowId: facts.flowId,
      platformMessageId: receipt.platformMessageId,
      heartbeatStaleForMs: assessment.staleForMs,
      heartbeatGateReason: assessment.reason,
    };
  };
}
