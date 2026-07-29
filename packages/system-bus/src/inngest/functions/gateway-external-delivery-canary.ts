import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type AppendMessageEventInput,
  type AppendMessageEventReceipt,
  GATEWAY_MESSAGE_EVENT_CONSUMER,
  getMessageEventLogClient,
  type MessageEventDocument,
  type MessageFlowTerminalState,
} from "@joelclaw/message-event-log";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

export const EXTERNAL_DELIVERY_CANARY_SOURCE = "gateway-external-canary";
export const EXTERNAL_DELIVERY_CANARY_CRON = "TZ=America/Los_Angeles 17 9 * * 2";
export const EXTERNAL_DELIVERY_CANARY_SLO_MS = 10 * 60_000;
export const EXTERNAL_DELIVERY_CANARY_POLL_MS = 30_000;
export const EXTERNAL_DELIVERY_CANARY_QUIET_HOLD_MS = 60_000;
export const EXTERNAL_DELIVERY_CANARY_RECEIPT_PATH = join(
  homedir(),
  ".joelclaw",
  "receipts",
  "gateway-external-delivery-canary.jsonl",
);
export const EXTERNAL_DELIVERY_CANARY_ALERT_BRIEF = resolve(
  import.meta.dir,
  "../../../../../.brain/tasks/gateway-external-canary-alert.svx",
);

const STREAM_PAGE_SIZE = 500;
const MAX_STREAM_EVENTS = 25_000;
const PENDING_SCAN_LIMIT = 100;
const EXTERNAL_INPUT_KINDS = new Set([
  "inbound.received",
  "message.requested",
  "action.received",
  "reaction.received",
  "aggregate.deadline.reached",
]);

export type ExternalCanaryMode = "off" | "manual" | "scheduled";
export type ExternalCanaryPath = "immediate" | "quiet-aggregate";
export type ExternalCanaryPathStatus = "pending" | "passed" | "failed" | "not-run";

export type ExternalCanaryPathReceipt = {
  path: ExternalCanaryPath;
  status: ExternalCanaryPathStatus;
  flowId: string;
  inputEventId?: string;
  requestedAt: number;
  observedAt: number;
  deadlineAt: number;
  terminalState?: MessageFlowTerminalState;
  terminalEventId?: string;
  deliveryConfirmationEventId?: string;
  latencyMs?: number;
  aggregateId?: string;
  openDecisionEventId?: string;
  aggregateDeadlineEventId?: string;
  closeDecisionEventId?: string;
  digestCount?: number;
  failure?: string;
};

export type OpenAggregateDeadline = {
  aggregateId: string;
  memberEventIds: string[];
  holdUntil: number | null;
  deadlineReached: boolean;
  overdueByMs: number;
  lastDecisionEventId: string;
};

export type ExternalCanaryStreamHealth = {
  pendingScanLimit: number;
  pendingScanTruncated: boolean;
  pendingExternalCount: number;
  oldestUnhandledExternal: {
    eventId: string;
    kind: string;
    recordedAt: number;
    ageMs: number;
  } | null;
  openAggregateCount: number;
  openAggregateDeadlines: OpenAggregateDeadline[];
  overdueAggregateCount: number;
  missingDeadlineCount: number;
};

export type ExternalCanaryOperatorAction = {
  requested: boolean;
  channel: "observer-telemetry-watch";
  schedule?: {
    event: "pane/schedule.requested";
    verb: "spawn";
    scheduleId: string;
    at: string;
    briefPath: string;
  };
};

export type ExternalDeliveryCanaryReceipt = {
  schemaVersion: 1;
  kind: "gateway-external-delivery-canary";
  runId: string;
  source: typeof EXTERNAL_DELIVERY_CANARY_SOURCE;
  status: "passed" | "failed";
  startedAt: number;
  completedAt: number;
  durationMs: number;
  deliverySloMs: number;
  receiptPath: string;
  paths: {
    immediate: ExternalCanaryPathReceipt;
    quietAggregate: ExternalCanaryPathReceipt;
  };
  streamHealth: ExternalCanaryStreamHealth;
  failures: string[];
  operatorAction: ExternalCanaryOperatorAction;
};

export type ExternalCanaryDependencies = {
  append(input: AppendMessageEventInput<"message.requested">): Promise<AppendMessageEventReceipt>;
  readEvents(recordedAt: number): Promise<MessageEventDocument[]>;
  pendingExternalInputs(): Promise<MessageEventDocument[]>;
  writeReceipt(receipt: ExternalDeliveryCanaryReceipt): Promise<string>;
  emitReceipt(receipt: ExternalDeliveryCanaryReceipt): Promise<void>;
  now(): number;
  newRunId(): string;
  machineId(): string;
  mode(): ExternalCanaryMode;
};

type AggregateDecision = {
  action?: string;
  aggregateId?: string;
  memberEventIds: string[];
  holdUntil?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function aggregateDecision(event: MessageEventDocument): AggregateDecision | null {
  if (event.kind !== "gateway.decision.recorded") return null;
  const decision = record(record(event.payload)?.decision);
  if (decision?.verb !== "aggregate") return null;
  return {
    action: typeof decision.action === "string" ? decision.action : undefined,
    aggregateId: typeof decision.aggregateId === "string" ? decision.aggregateId : undefined,
    memberEventIds: stringArray(decision.memberEventIds),
    holdUntil: typeof decision.holdUntil === "number" ? decision.holdUntil : undefined,
  };
}

function decisionCoversInput(event: MessageEventDocument, inputEventId: string): boolean {
  if (event.kind !== "gateway.decision.recorded") return false;
  const payload = record(event.payload);
  const decision = record(payload?.decision);
  return (
    stringArray(payload?.inputEventIds).includes(inputEventId) ||
    stringArray(decision?.memberEventIds).includes(inputEventId)
  );
}

function decisionVerb(event: MessageEventDocument): string | undefined {
  const verb = record(record(event.payload)?.decision)?.verb;
  return typeof verb === "string" ? verb : undefined;
}

function deliveryEvents(
  events: readonly MessageEventDocument[],
  kind: "delivery.confirmed" | "delivery.failed",
  flowId: string,
): MessageEventDocument[] {
  return events.filter((event) => event.kind === kind && event.flowId === flowId);
}

export function evaluateImmediateCanaryPath(input: {
  events: readonly MessageEventDocument[];
  flowId: string;
  inputEventId: string;
  requestedAt: number;
  observedAt: number;
  deadlineAt: number;
}): ExternalCanaryPathReceipt {
  const base = {
    path: "immediate" as const,
    flowId: input.flowId,
    inputEventId: input.inputEventId,
    requestedAt: input.requestedAt,
    observedAt: input.observedAt,
    deadlineAt: input.deadlineAt,
  };
  const confirmed = deliveryEvents(input.events, "delivery.confirmed", input.flowId);
  const failed = deliveryEvents(input.events, "delivery.failed", input.flowId);
  const decisions = input.events.filter((event) => decisionCoversInput(event, input.inputEventId));

  if (confirmed.length > 1) {
    return {
      ...base,
      status: "failed",
      failure: `immediate path produced ${confirmed.length} confirmed deliveries`,
    };
  }
  if (failed.length > 0) {
    return {
      ...base,
      status: "failed",
      terminalState: "failed",
      terminalEventId: failed[0]?._id,
      failure: "immediate path recorded delivery.failed",
    };
  }
  if (confirmed.length === 1) {
    const terminal = confirmed[0]!;
    return {
      ...base,
      status: "passed",
      terminalState: "confirmed",
      terminalEventId: terminal._id,
      latencyMs: Math.max(0, terminal.occurredAt - input.requestedAt),
    };
  }

  const wrongTerminal = decisions.find((event) => {
    const verb = decisionVerb(event);
    return verb === "drop" || verb === "route" || verb === "fanout";
  });
  if (wrongTerminal) {
    return {
      ...base,
      status: "failed",
      terminalEventId: wrongTerminal._id,
      failure: `immediate path received gateway decision ${decisionVerb(wrongTerminal)}`,
    };
  }
  if (input.observedAt >= input.deadlineAt) {
    return {
      ...base,
      status: "failed",
      failure: `immediate path exceeded ${input.deadlineAt - input.requestedAt}ms delivery SLO`,
    };
  }
  return { ...base, status: "pending" };
}

export function evaluateQuietAggregateCanaryPath(input: {
  events: readonly MessageEventDocument[];
  flowId: string;
  inputEventId: string;
  requestedAt: number;
  observedAt: number;
  deadlineAt: number;
}): ExternalCanaryPathReceipt {
  const base = {
    path: "quiet-aggregate" as const,
    flowId: input.flowId,
    inputEventId: input.inputEventId,
    requestedAt: input.requestedAt,
    observedAt: input.observedAt,
    deadlineAt: input.deadlineAt,
  };
  const relatedDecisions = input.events.filter((event) =>
    decisionCoversInput(event, input.inputEventId),
  );
  const aggregateDecisions = relatedDecisions
    .map((event) => ({ event, decision: aggregateDecision(event) }))
    .filter(
      (item): item is { event: MessageEventDocument; decision: AggregateDecision } =>
        item.decision !== null,
    );
  const open = aggregateDecisions.find(({ decision }) => decision.action === "open");

  const immediateConfirmations = deliveryEvents(input.events, "delivery.confirmed", input.flowId);
  if (!open && immediateConfirmations.length > 0) {
    return {
      ...base,
      status: "failed",
      terminalEventId: immediateConfirmations[0]?._id,
      digestCount: immediateConfirmations.length,
      failure: "quiet path delivered immediately instead of opening an aggregate",
    };
  }

  const wrongTerminal = relatedDecisions.find((event) => {
    const verb = decisionVerb(event);
    return verb !== "aggregate" && verb !== "escalate";
  });
  if (!open && wrongTerminal) {
    return {
      ...base,
      status: "failed",
      terminalEventId: wrongTerminal._id,
      failure: `quiet path received gateway decision ${decisionVerb(wrongTerminal)}`,
    };
  }

  if (open && open.decision.holdUntil === undefined) {
    return {
      ...base,
      status: "failed",
      aggregateId: open.decision.aggregateId,
      openDecisionEventId: open.event._id,
      failure: "quiet aggregate opened without holdUntil",
    };
  }
  if (open && !open.decision.aggregateId) {
    return {
      ...base,
      status: "failed",
      openDecisionEventId: open.event._id,
      failure: "quiet aggregate opened without aggregateId",
    };
  }

  const aggregateId = open?.decision.aggregateId;
  const closes = aggregateDecisions.filter(
    ({ decision }) => decision.action === "close-deliver" && decision.aggregateId === aggregateId,
  );
  if (closes.length > 1) {
    return {
      ...base,
      status: "failed",
      aggregateId,
      openDecisionEventId: open?.event._id,
      digestCount: closes.length,
      failure: `quiet aggregate produced ${closes.length} close-deliver decisions`,
    };
  }

  const deadlineEvent =
    open && aggregateId
      ? input.events.find((event) => {
          if (event.kind !== "aggregate.deadline.reached") return false;
          const payload = record(event.payload);
          return (
            payload?.aggregateId === aggregateId && payload?.holdUntil === open.decision.holdUntil
          );
        })
      : undefined;
  const close = closes[0];
  const closeFlowId = close ? (close.event.flowId ?? `decision:${close.event._id}`) : undefined;
  const closeConfirmations = closeFlowId
    ? deliveryEvents(input.events, "delivery.confirmed", closeFlowId)
    : [];
  const confirmations = close
    ? closeConfirmations.filter((event) => event.sequence > close.event.sequence)
    : [];
  const failed = closeFlowId
    ? deliveryEvents(input.events, "delivery.failed", closeFlowId).filter(
        (event) => !close || event.sequence > close.event.sequence,
      )
    : [];

  if (open && close && closeConfirmations.some((event) => event.sequence <= close.event.sequence)) {
    return {
      ...base,
      status: "failed",
      aggregateId,
      openDecisionEventId: open.event._id,
      aggregateDeadlineEventId: deadlineEvent?._id,
      closeDecisionEventId: close.event._id,
      digestCount: confirmations.length,
      failure: "quiet path confirmed delivery before the aggregate closed",
    };
  }
  if (deadlineEvent && close && close.event.sequence <= deadlineEvent.sequence) {
    return {
      ...base,
      status: "failed",
      aggregateId,
      openDecisionEventId: open?.event._id,
      aggregateDeadlineEventId: deadlineEvent._id,
      closeDecisionEventId: close.event._id,
      digestCount: confirmations.length,
      failure: "quiet aggregate closed before its deadline event",
    };
  }

  if (confirmations.length > 1) {
    return {
      ...base,
      status: "failed",
      aggregateId,
      openDecisionEventId: open?.event._id,
      aggregateDeadlineEventId: deadlineEvent?._id,
      closeDecisionEventId: close?.event._id,
      digestCount: confirmations.length,
      failure: `quiet aggregate produced ${confirmations.length} confirmed digests`,
    };
  }
  if (failed.length > 0) {
    return {
      ...base,
      status: "failed",
      terminalState: "failed",
      aggregateId,
      openDecisionEventId: open?.event._id,
      aggregateDeadlineEventId: deadlineEvent?._id,
      closeDecisionEventId: close?.event._id,
      terminalEventId: failed[0]?._id,
      digestCount: confirmations.length,
      failure: "quiet aggregate recorded delivery.failed",
    };
  }
  if (open && deadlineEvent && close && confirmations.length === 1) {
    const deliveryConfirmation = confirmations[0]!;
    return {
      ...base,
      status: "passed",
      terminalState: "digested",
      terminalEventId: close.event._id,
      deliveryConfirmationEventId: deliveryConfirmation._id,
      latencyMs: Math.max(0, close.event.occurredAt - input.requestedAt),
      aggregateId,
      openDecisionEventId: open.event._id,
      aggregateDeadlineEventId: deadlineEvent._id,
      closeDecisionEventId: close.event._id,
      digestCount: 1,
    };
  }
  if (input.observedAt >= input.deadlineAt) {
    return {
      ...base,
      status: "failed",
      aggregateId,
      openDecisionEventId: open?.event._id,
      aggregateDeadlineEventId: deadlineEvent?._id,
      closeDecisionEventId: close?.event._id,
      digestCount: confirmations.length,
      failure: `quiet aggregate exceeded ${input.deadlineAt - input.requestedAt}ms delivery SLO`,
    };
  }
  return {
    ...base,
    status: "pending",
    aggregateId,
    openDecisionEventId: open?.event._id,
    aggregateDeadlineEventId: deadlineEvent?._id,
    closeDecisionEventId: close?.event._id,
    digestCount: confirmations.length,
  };
}

export function inspectOpenAggregateDeadlines(
  events: readonly MessageEventDocument[],
  now: number,
): OpenAggregateDeadline[] {
  const active = new Map<string, Omit<OpenAggregateDeadline, "deadlineReached" | "overdueByMs">>();
  const fired = new Set<string>();

  for (const event of events) {
    const decision = aggregateDecision(event);
    if (decision?.aggregateId) {
      if (decision.action === "close-deliver") {
        active.delete(decision.aggregateId);
      } else if (
        decision.action === "open" ||
        decision.action === "join" ||
        decision.action === "extend"
      ) {
        const prior = active.get(decision.aggregateId);
        active.set(decision.aggregateId, {
          aggregateId: decision.aggregateId,
          memberEventIds: [
            ...new Set([...(prior?.memberEventIds ?? []), ...decision.memberEventIds]),
          ],
          holdUntil: decision.holdUntil ?? prior?.holdUntil ?? null,
          lastDecisionEventId: event._id,
        });
      }
    }
    if (event.kind === "aggregate.deadline.reached") {
      const payload = record(event.payload);
      if (typeof payload?.aggregateId === "string" && typeof payload.holdUntil === "number") {
        fired.add(`${payload.aggregateId}:${payload.holdUntil}`);
      }
    }
  }

  return [...active.values()]
    .map((entry) => ({
      ...entry,
      deadlineReached:
        entry.holdUntil !== null && fired.has(`${entry.aggregateId}:${entry.holdUntil}`),
      overdueByMs: entry.holdUntil === null ? 0 : Math.max(0, now - entry.holdUntil),
    }))
    .sort((left, right) => {
      if (left.holdUntil === null) return -1;
      if (right.holdUntil === null) return 1;
      return left.holdUntil - right.holdUntil;
    });
}

export function inspectExternalCanaryStreamHealth(input: {
  events: readonly MessageEventDocument[];
  pending: readonly MessageEventDocument[];
  now: number;
}): ExternalCanaryStreamHealth {
  const external = input.pending.filter((event) => EXTERNAL_INPUT_KINDS.has(event.kind));
  const oldest = external[0];
  const openAggregates = inspectOpenAggregateDeadlines(input.events, input.now);
  return {
    pendingScanLimit: PENDING_SCAN_LIMIT,
    pendingScanTruncated: input.pending.length >= PENDING_SCAN_LIMIT,
    pendingExternalCount: external.length,
    oldestUnhandledExternal: oldest
      ? {
          eventId: oldest._id,
          kind: oldest.kind,
          recordedAt: oldest.recordedAt,
          ageMs: Math.max(0, input.now - oldest.recordedAt),
        }
      : null,
    openAggregateCount: openAggregates.length,
    openAggregateDeadlines: openAggregates.slice(0, 25),
    overdueAggregateCount: openAggregates.filter(
      (aggregate) =>
        aggregate.holdUntil !== null && aggregate.overdueByMs > EXTERNAL_DELIVERY_CANARY_SLO_MS,
    ).length,
    missingDeadlineCount: openAggregates.filter((aggregate) => aggregate.holdUntil === null).length,
  };
}

export function buildOperatorActionSchedule(input: {
  runId: string;
  completedAt: number;
  receiptPath?: string;
}) {
  const at = new Date(input.completedAt + 30_000).toISOString();
  const scheduleId = `gateway-external-canary-alert-${input.runId}`;
  const receiptPath = input.receiptPath ?? EXTERNAL_DELIVERY_CANARY_RECEIPT_PATH;
  return {
    version: 1 as const,
    scheduleId,
    verb: "spawn" as const,
    at,
    briefPath: EXTERNAL_DELIVERY_CANARY_ALERT_BRIEF,
    prompt: [
      `Gateway external delivery canary run ${input.runId} failed.`,
      `Read its JSONL receipt at ${receiptPath}.`,
      "Inspect OTEL action gateway.external_canary.failed.",
      "Request operator action. Do not send a canary, start a listener, restart, or reconfigure anything.",
    ].join(" "),
    requestedBy: EXTERNAL_DELIVERY_CANARY_SOURCE,
    createdAt: new Date(input.completedAt).toISOString(),
  };
}

function streamFailures(streamHealth: ExternalCanaryStreamHealth): string[] {
  const failures: string[] = [];
  if (streamHealth.pendingScanTruncated) {
    failures.push(`gateway pending scan reached its ${streamHealth.pendingScanLimit}-event bound`);
  }
  const oldestAge = streamHealth.oldestUnhandledExternal?.ageMs;
  if (oldestAge !== undefined && oldestAge > EXTERNAL_DELIVERY_CANARY_SLO_MS) {
    failures.push(`oldest unhandled external input is ${oldestAge}ms old`);
  }
  if (streamHealth.missingDeadlineCount > 0) {
    failures.push(`${streamHealth.missingDeadlineCount} open aggregate(s) have no deadline`);
  }
  if (streamHealth.overdueAggregateCount > 0) {
    failures.push(
      `${streamHealth.overdueAggregateCount} open aggregate deadline(s) exceed the delivery SLO`,
    );
  }
  return failures;
}

export function buildExternalDeliveryCanaryReceipt(input: {
  runId: string;
  startedAt: number;
  completedAt: number;
  receiptPath?: string;
  immediate: ExternalCanaryPathReceipt;
  quietAggregate: ExternalCanaryPathReceipt;
  streamHealth: ExternalCanaryStreamHealth;
}): ExternalDeliveryCanaryReceipt {
  const failures = [
    ...(input.immediate.status === "passed"
      ? []
      : [input.immediate.failure ?? "immediate path did not pass"]),
    ...(input.quietAggregate.status === "passed"
      ? []
      : [input.quietAggregate.failure ?? "quiet aggregate path did not pass"]),
    ...streamFailures(input.streamHealth),
  ];
  const completedAt = Math.max(input.startedAt, input.completedAt);
  const status = failures.length === 0 ? "passed" : "failed";
  const receiptPath = input.receiptPath ?? EXTERNAL_DELIVERY_CANARY_RECEIPT_PATH;
  const schedule =
    status === "failed"
      ? buildOperatorActionSchedule({
          runId: input.runId,
          completedAt,
          receiptPath,
        })
      : undefined;

  return {
    schemaVersion: 1,
    kind: "gateway-external-delivery-canary",
    runId: input.runId,
    source: EXTERNAL_DELIVERY_CANARY_SOURCE,
    status,
    startedAt: input.startedAt,
    completedAt,
    durationMs: completedAt - input.startedAt,
    deliverySloMs: EXTERNAL_DELIVERY_CANARY_SLO_MS,
    receiptPath,
    paths: {
      immediate: input.immediate,
      quietAggregate: input.quietAggregate,
    },
    streamHealth: input.streamHealth,
    failures,
    operatorAction: {
      requested: status === "failed",
      channel: "observer-telemetry-watch",
      ...(schedule
        ? {
            schedule: {
              event: "pane/schedule.requested",
              verb: "spawn",
              scheduleId: schedule.scheduleId,
              at: schedule.at,
              briefPath: schedule.briefPath,
            },
          }
        : {}),
    },
  };
}

export async function appendExternalCanaryReceipt(
  receipt: ExternalDeliveryCanaryReceipt,
  path = EXTERNAL_DELIVERY_CANARY_RECEIPT_PATH,
): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

export function resolveExternalCanaryMode(
  value = process.env.GATEWAY_EXTERNAL_CANARY_MODE,
): ExternalCanaryMode {
  const normalized = value?.trim().toLowerCase() ?? "off";
  if (normalized === "off" || normalized === "manual" || normalized === "scheduled") {
    return normalized;
  }
  return "off";
}

export function shouldRunExternalCanary(input: {
  mode: ExternalCanaryMode;
  eventName: string;
  liveApproved?: boolean;
}): { run: boolean; reason: string } {
  const manual = input.eventName === "gateway/external-canary.requested";
  if (input.mode === "off") {
    return { run: false, reason: "GATEWAY_EXTERNAL_CANARY_MODE=off" };
  }
  if (manual && input.liveApproved !== true) {
    return {
      run: false,
      reason: "manual canary requires liveApproved=true",
    };
  }
  if (!manual && input.mode !== "scheduled") {
    return {
      run: false,
      reason: "scheduled canary requires GATEWAY_EXTERNAL_CANARY_MODE=scheduled",
    };
  }
  return { run: true, reason: manual ? "manual-approved" : "scheduled" };
}

function canaryMessageInput(input: {
  runId: string;
  path: ExternalCanaryPath;
  occurredAt: number;
  machineId: string;
}): AppendMessageEventInput<"message.requested"> {
  const pathKey = input.path === "immediate" ? "immediate" : "quiet-aggregate";
  const flowId = `canary:${input.runId}:${pathKey}`;
  const text =
    input.path === "immediate"
      ? `🧪 [telegram-external-canary path=immediate run=${input.runId}] Immediate visible delivery proof. No operator action is needed.`
      : `🧪 [telegram-external-canary path=quiet-aggregate run=${input.runId}] Quiet aggregate digest proof. No operator action is needed.`;
  return {
    semanticKey: `canary:${input.runId}:${pathKey}`,
    kind: "message.requested",
    source: EXTERNAL_DELIVERY_CANARY_SOURCE,
    flowId,
    origin: {
      producer: EXTERNAL_DELIVERY_CANARY_SOURCE,
      machineId: input.machineId,
    },
    correlationId: `canary:${input.runId}:${pathKey}`,
    rawSourceId: `${input.runId}:${pathKey}`,
    occurredAt: input.occurredAt,
    payload: {
      text,
      canary: {
        schemaVersion: 1,
        runId: input.runId,
        path: pathKey,
        synthetic: true,
        holdForMs: input.path === "quiet-aggregate" ? EXTERNAL_DELIVERY_CANARY_QUIET_HOLD_MS : 0,
        expectedTerminal: "delivery.confirmed",
      },
    },
  };
}

async function readMessageEventsSince(recordedAt: number): Promise<MessageEventDocument[]> {
  const client = getMessageEventLogClient();
  const events: MessageEventDocument[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = await client.readSince(recordedAt, STREAM_PAGE_SIZE, cursor);
    events.push(...page.events);
    if (events.length >= MAX_STREAM_EVENTS && page.nextCursor !== null) {
      throw new Error(`message event scan exceeded ${MAX_STREAM_EVENTS} events`);
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) {
        throw new Error(`message event log repeated cursor ${cursor}`);
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== null);

  return events;
}

async function emitExternalCanaryReceipt(receipt: ExternalDeliveryCanaryReceipt): Promise<void> {
  const result = await emitOtelEvent({
    level: receipt.status === "passed" ? "info" : "error",
    source: "worker",
    component: EXTERNAL_DELIVERY_CANARY_SOURCE,
    action:
      receipt.status === "passed"
        ? "gateway.external_canary.passed"
        : "gateway.external_canary.failed",
    success: receipt.status === "passed",
    error: receipt.status === "failed" ? receipt.failures.join("; ") : undefined,
    duration_ms: receipt.durationMs,
    metadata: {
      runId: receipt.runId,
      receiptPath: receipt.receiptPath,
      deliverySloMs: receipt.deliverySloMs,
      immediateStatus: receipt.paths.immediate.status,
      immediateLatencyMs: receipt.paths.immediate.latencyMs ?? null,
      quietAggregateStatus: receipt.paths.quietAggregate.status,
      quietAggregateLatencyMs: receipt.paths.quietAggregate.latencyMs ?? null,
      quietAggregateId: receipt.paths.quietAggregate.aggregateId ?? null,
      quietDigestCount: receipt.paths.quietAggregate.digestCount ?? 0,
      oldestUnhandledExternalAgeMs: receipt.streamHealth.oldestUnhandledExternal?.ageMs ?? null,
      openAggregateCount: receipt.streamHealth.openAggregateCount,
      overdueAggregateCount: receipt.streamHealth.overdueAggregateCount,
      missingDeadlineCount: receipt.streamHealth.missingDeadlineCount,
      operatorActionRequested: receipt.operatorAction.requested,
    },
  });
  const persisted =
    result.stored ||
    result.clickhouse.written ||
    result.clickhouse.queued ||
    result.typesense.written ||
    result.convex.written;
  if (!persisted) {
    throw new Error(
      `external canary OTEL receipt was not persisted: ${result.error ?? result.clickhouse.error ?? "unknown store failure"}`,
    );
  }
}

const defaultDependencies: ExternalCanaryDependencies = {
  append: (input) => getMessageEventLogClient().append(input),
  readEvents: readMessageEventsSince,
  pendingExternalInputs: () =>
    getMessageEventLogClient().pendingForConsumer(
      GATEWAY_MESSAGE_EVENT_CONSUMER,
      PENDING_SCAN_LIMIT,
    ),
  writeReceipt: (receipt) => appendExternalCanaryReceipt(receipt, receipt.receiptPath),
  emitReceipt: emitExternalCanaryReceipt,
  now: Date.now,
  newRunId: randomUUID,
  machineId: () =>
    process.env.JOELCLAW_MACHINE_ID?.trim() ||
    hostname()
      .trim()
      .toLowerCase()
      .replace(/\.localdomain$|\.local$/u, "") ||
    "unknown",
  mode: resolveExternalCanaryMode,
};

function notRunPath(
  path: ExternalCanaryPath,
  flowId: string,
  startedAt: number,
  observedAt: number,
  failure: string,
): ExternalCanaryPathReceipt {
  return {
    path,
    status: "not-run",
    flowId,
    requestedAt: startedAt,
    observedAt,
    deadlineAt: startedAt + EXTERNAL_DELIVERY_CANARY_SLO_MS,
    failure,
  };
}

export function createGatewayExternalDeliveryCanary(
  dependencies: ExternalCanaryDependencies = defaultDependencies,
) {
  return inngest.createFunction(
    {
      id: "gateway/external-delivery-canary",
      name: "Gateway: External Delivery Canary",
      concurrency: { limit: 1 },
      singleton: { key: '"global"', mode: "skip" },
      timeouts: { finish: "30m" },
      onFailure: async ({ event, error, step }) => {
        const emergency = await step.run("build-unhandled-external-canary-failure", () => {
          const startedAt = dependencies.now();
          const completedAt = startedAt;
          const runId = event.id ?? dependencies.newRunId();
          const failure = `unhandled canary function failure: ${
            error instanceof Error ? error.message : String(error)
          }`;
          return buildExternalDeliveryCanaryReceipt({
            runId,
            startedAt,
            completedAt,
            immediate: notRunPath(
              "immediate",
              `canary:${runId}:immediate`,
              startedAt,
              completedAt,
              failure,
            ),
            quietAggregate: notRunPath(
              "quiet-aggregate",
              `canary:${runId}:quiet-aggregate`,
              startedAt,
              completedAt,
              failure,
            ),
            streamHealth: {
              pendingScanLimit: PENDING_SCAN_LIMIT,
              pendingScanTruncated: false,
              pendingExternalCount: 0,
              oldestUnhandledExternal: null,
              openAggregateCount: 0,
              openAggregateDeadlines: [],
              overdueAggregateCount: 0,
              missingDeadlineCount: 0,
            },
          });
        });
        const schedule = buildOperatorActionSchedule({
          runId: emergency.runId,
          completedAt: emergency.completedAt,
          receiptPath: emergency.receiptPath,
        });
        await step.sendEvent("schedule-unhandled-canary-operator-action", {
          name: "pane/schedule.requested",
          data: schedule,
        });
        await step.run("write-unhandled-external-canary-receipt", () =>
          dependencies.writeReceipt(emergency),
        );
        await step.run("emit-unhandled-external-canary-receipt", () =>
          dependencies.emitReceipt(emergency),
        );
      },
    },
    [{ event: "gateway/external-canary.requested" }, { cron: EXTERNAL_DELIVERY_CANARY_CRON }],
    async ({ event, step }) => {
      const gate = await step.run("resolve-external-canary-gate", () => {
        const data = record(event.data);
        return shouldRunExternalCanary({
          mode: dependencies.mode(),
          eventName: event.name,
          liveApproved: data?.liveApproved === true,
        });
      });
      if (!gate.run) {
        return { status: "skipped", reason: gate.reason };
      }

      const prepared = await step.run("prepare-external-canary-run", () => {
        const startedAt = dependencies.now();
        return {
          runId: dependencies.newRunId(),
          startedAt,
          machineId: dependencies.machineId(),
        };
      });
      const scanSince = Math.max(0, prepared.startedAt - 5_000);

      const immediateInput = canaryMessageInput({
        runId: prepared.runId,
        path: "immediate",
        occurredAt: prepared.startedAt,
        machineId: prepared.machineId,
      });
      const immediateAppend = await step.run("append-immediate-canary-message", () =>
        dependencies.append(immediateInput),
      );
      const immediateFlowId = immediateInput.flowId;
      if (!immediateFlowId) {
        throw new Error("immediate canary input has no flowId");
      }
      let immediate = evaluateImmediateCanaryPath({
        events: [],
        flowId: immediateFlowId,
        inputEventId: immediateAppend.eventId,
        requestedAt: prepared.startedAt,
        observedAt: prepared.startedAt,
        deadlineAt: prepared.startedAt + EXTERNAL_DELIVERY_CANARY_SLO_MS,
      });
      const maxPolls = Math.ceil(
        EXTERNAL_DELIVERY_CANARY_SLO_MS / EXTERNAL_DELIVERY_CANARY_POLL_MS,
      );
      for (let attempt = 0; attempt <= maxPolls && immediate.status === "pending"; attempt += 1) {
        const observation = await step.run(`inspect-immediate-canary-${attempt}`, async () => ({
          events: await dependencies.readEvents(scanSince),
          observedAt: dependencies.now(),
        }));
        immediate = evaluateImmediateCanaryPath({
          ...observation,
          flowId: immediateFlowId,
          inputEventId: immediateAppend.eventId,
          requestedAt: prepared.startedAt,
          deadlineAt: prepared.startedAt + EXTERNAL_DELIVERY_CANARY_SLO_MS,
        });
        if (immediate.status === "pending" && attempt < maxPolls) {
          await step.sleep(
            `wait-immediate-canary-${attempt}`,
            `${EXTERNAL_DELIVERY_CANARY_POLL_MS}ms`,
          );
        }
      }

      const quietPreparedAt = await step.run("prepare-quiet-aggregate-canary", dependencies.now);
      const quietInput = canaryMessageInput({
        runId: prepared.runId,
        path: "quiet-aggregate",
        occurredAt: quietPreparedAt,
        machineId: prepared.machineId,
      });
      const quietAppend = await step.run("append-quiet-aggregate-canary-message", () =>
        dependencies.append(quietInput),
      );
      const quietFlowId = quietInput.flowId;
      if (!quietFlowId) {
        throw new Error("quiet aggregate canary input has no flowId");
      }
      let quietAggregate = evaluateQuietAggregateCanaryPath({
        events: [],
        flowId: quietFlowId,
        inputEventId: quietAppend.eventId,
        requestedAt: quietPreparedAt,
        observedAt: quietPreparedAt,
        deadlineAt: quietPreparedAt + EXTERNAL_DELIVERY_CANARY_SLO_MS,
      });
      for (
        let attempt = 0;
        attempt <= maxPolls && quietAggregate.status === "pending";
        attempt += 1
      ) {
        const observation = await step.run(
          `inspect-quiet-aggregate-canary-${attempt}`,
          async () => ({
            events: await dependencies.readEvents(scanSince),
            observedAt: dependencies.now(),
          }),
        );
        quietAggregate = evaluateQuietAggregateCanaryPath({
          ...observation,
          flowId: quietFlowId,
          inputEventId: quietAppend.eventId,
          requestedAt: quietPreparedAt,
          deadlineAt: quietPreparedAt + EXTERNAL_DELIVERY_CANARY_SLO_MS,
        });
        if (quietAggregate.status === "pending" && attempt < maxPolls) {
          await step.sleep(
            `wait-quiet-aggregate-canary-${attempt}`,
            `${EXTERNAL_DELIVERY_CANARY_POLL_MS}ms`,
          );
        }
      }

      const finalSnapshot = await step.run("inspect-external-canary-stream-health", async () => {
        const [events, pending] = await Promise.all([
          dependencies.readEvents(0),
          dependencies.pendingExternalInputs(),
        ]);
        const completedAt = dependencies.now();
        return {
          completedAt,
          streamHealth: inspectExternalCanaryStreamHealth({
            events,
            pending,
            now: completedAt,
          }),
        };
      });
      const receipt = await step.run("build-external-canary-receipt", () =>
        buildExternalDeliveryCanaryReceipt({
          runId: prepared.runId,
          startedAt: prepared.startedAt,
          completedAt: finalSnapshot.completedAt,
          immediate,
          quietAggregate,
          streamHealth: finalSnapshot.streamHealth,
        }),
      );
      if (receipt.status === "failed") {
        const schedule = buildOperatorActionSchedule({
          runId: receipt.runId,
          completedAt: receipt.completedAt,
          receiptPath: receipt.receiptPath,
        });
        await step.sendEvent("schedule-canary-operator-action", {
          name: "pane/schedule.requested",
          data: schedule,
        });
      }
      await step.run("write-external-canary-receipt", () => dependencies.writeReceipt(receipt));
      await step.run("emit-external-canary-receipt", () => dependencies.emitReceipt(receipt));

      return receipt;
    },
  );
}

export const gatewayExternalDeliveryCanary = createGatewayExternalDeliveryCanary();
