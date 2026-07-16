import {
  type InvestigationBudgets,
  type OutboundCandidate,
  type PolicyDecision,
  signalLifecycleMachine,
  telegramOutboundPolicy,
} from "@joelclaw/signal";
import {
  type ChannelDeliveryAudit,
  emitGatewayOtel,
} from "@joelclaw/telemetry";
import { type ActorRefFrom, createActor } from "xstate";
import { journalMessage } from "./message-journal";

export const TELEGRAM_SPECIALIZED_UI_SURFACES = [
  "command",
  "mcq",
  "pinned-status",
  "worktree",
] as const;

export type TelegramSpecializedUiSurface =
  (typeof TELEGRAM_SPECIALIZED_UI_SURFACES)[number];

export type TelegramOutboundExemption =
  | {
      kind: "conversation-reply";
      marker: "telegram-policy-exempt:conversation-reply";
      chatId: number;
    }
  | {
      kind: "specialized-ui";
      marker: `telegram-policy-exempt:specialized-ui:${TelegramSpecializedUiSurface}`;
      surface: TelegramSpecializedUiSurface;
    };

export type TelegramOutboundPolicyContext = {
  sourceEventType?: string;
  sourceClassification?: string;
  sourceReason?: string;
  level?: OutboundCandidate["level"];
  priority?: OutboundCandidate["priority"];
  exemption?: TelegramOutboundExemption;
  investigationBudgets?: Partial<InvestigationBudgets>;
};

export type TelegramOutboundRoute = {
  disposition: PolicyDecision["disposition"];
  decision: PolicyDecision;
  lifecycleState?: string;
};

type RouteInput = {
  chatId: number;
  content: string;
  audit: ChannelDeliveryAudit;
  contentKind?: string;
  transportText?: string;
  policy?: TelegramOutboundPolicyContext;
};

type PolicyRuntimeDependencies = {
  queueDigest: (input: RouteInput, decision: PolicyDecision) => Promise<void>;
  journalSuppression: (input: RouteInput, decision: PolicyDecision) => Promise<void>;
};

const DEFAULT_INVESTIGATION_BUDGETS: InvestigationBudgets = {
  timeMs: 5 * 60_000,
  retries: 2,
  spendUsd: 0.25,
  mutationAuthority: "read",
  scope: ["gateway-diagnostics"],
};

const MAX_ACTIVE_INVESTIGATIONS = 500;
const activeInvestigations = new Map<
  string,
  { actor: ActorRefFrom<typeof signalLifecycleMachine>; startedAt: number }
>();

export function telegramConversationReplyExemption(
  chatId: number,
): TelegramOutboundExemption {
  return {
    kind: "conversation-reply",
    marker: "telegram-policy-exempt:conversation-reply",
    chatId,
  };
}

export function telegramSpecializedUiExemption(
  surface: TelegramSpecializedUiSurface,
): TelegramOutboundExemption {
  return {
    kind: "specialized-ui",
    marker: `telegram-policy-exempt:specialized-ui:${surface}`,
    surface,
  };
}

export function resolveTelegramOutboundPolicyContext(
  metadata: Record<string, unknown> | undefined,
  source: string | undefined,
): TelegramOutboundPolicyContext {
  const eventTypes = Array.isArray(metadata?.eventTypes)
    ? metadata.eventTypes.filter((value): value is string => typeof value === "string")
    : [];
  const eventPriorities = Array.isArray(metadata?.eventPriorities)
    ? metadata.eventPriorities.filter((value): value is string => typeof value === "string")
    : [];
  const eventLevels = Array.isArray(metadata?.eventLevels)
    ? metadata.eventLevels.filter((value): value is string => typeof value === "string")
    : [];
  const priority = (["urgent", "high", "normal", "low"] as const)
    .find((value) => eventPriorities.includes(value));
  const level = (["fatal", "error", "warn", "info", "debug"] as const)
    .find((value) => eventLevels.includes(value));
  const policySourceEventType = typeof metadata?.policySourceEventType === "string"
    ? metadata.policySourceEventType
    : eventTypes[0];
  const sourceClassification = typeof metadata?.signalClassification === "string"
    ? metadata.signalClassification
    : undefined;
  const sourceReason = typeof metadata?.signalReason === "string"
    ? metadata.signalReason
    : undefined;
  const trustedTelegramChatId = metadata?.telegramChatId;
  const trustedTelegramMessageId = metadata?.telegramMessageId;
  const isTrustedTelegramInbound = metadata?.trustedTelegramInbound === true
    && typeof trustedTelegramChatId === "number"
    && Number.isInteger(trustedTelegramChatId)
    && typeof trustedTelegramMessageId === "number"
    && Number.isInteger(trustedTelegramMessageId)
    && source === `telegram:${trustedTelegramChatId}`;

  return {
    ...(policySourceEventType
      ? { sourceEventType: policySourceEventType }
      : source
        ? { sourceEventType: source }
        : {}),
    ...(sourceClassification ? { sourceClassification } : {}),
    ...(sourceReason ? { sourceReason } : {}),
    ...(priority ? { priority } : {}),
    ...(level ? { level } : {}),
    ...(isTrustedTelegramInbound
      ? { exemption: telegramConversationReplyExemption(trustedTelegramChatId) }
      : {}),
  };
}

/**
 * Marks direct Bot API UI code as an intentional policy bypass. The returned API
 * is unchanged; the marker makes exemptions grep-able and type-checked.
 */
export function specializedTelegramApi<T>(
  api: T,
  surface: TelegramSpecializedUiSurface,
): T {
  void telegramSpecializedUiExemption(surface);
  return api;
}

function exemptionDecision(
  input: RouteInput,
  exemption: TelegramOutboundExemption,
): PolicyDecision {
  if (exemption.kind === "conversation-reply") {
    return {
      disposition: "deliver",
      category: "action",
      reason: "deliver.exempt.joel-initiated-conversation-reply",
      producer: input.audit.producer,
    };
  }

  return {
    disposition: "deliver",
    category: "action",
    reason: `deliver.exempt.specialized-ui.${exemption.surface}`,
    producer: input.audit.producer,
  };
}

function toCandidate(input: RouteInput): OutboundCandidate {
  const policy = input.policy;
  return {
    content: input.content,
    producer: input.audit.producer,
    ...(policy?.level ? { level: policy.level } : {}),
    ...(policy?.priority ? { priority: policy.priority } : {}),
    sourceEventType:
      policy?.sourceEventType?.trim()
      || input.audit.route?.trim()
      || input.audit.producer.trim()
      || "telegram.outbound.unclassified",
    auditLineage: {
      signalId: input.audit.flowId,
      flowId: input.audit.flowId,
      ...(input.audit.eventId ? { sourceEventId: input.audit.eventId } : {}),
    },
  };
}

function investigationBudgets(
  overrides: Partial<InvestigationBudgets> | undefined,
): InvestigationBudgets {
  return {
    ...DEFAULT_INVESTIGATION_BUDGETS,
    ...overrides,
    scope: overrides?.scope
      ? [...overrides.scope]
      : [...DEFAULT_INVESTIGATION_BUDGETS.scope],
  };
}

function pruneInvestigations(): void {
  while (activeInvestigations.size >= MAX_ACTIVE_INVESTIGATIONS) {
    const oldest = [...activeInvestigations.entries()]
      .sort(([, left], [, right]) => left.startedAt - right.startedAt)[0];
    if (!oldest) return;
    oldest[1].actor.stop();
    activeInvestigations.delete(oldest[0]);
  }
}

function spawnInvestigation(
  candidate: OutboundCandidate,
  policy: TelegramOutboundPolicyContext | undefined,
): string {
  const existing = activeInvestigations.get(candidate.auditLineage.signalId);
  if (existing) {
    existing.actor.send({
      type: "DUPLICATE_DETECTED",
      signalId: candidate.auditLineage.signalId,
    });
    return String(existing.actor.getSnapshot().value);
  }

  pruneInvestigations();
  const actor = createActor(signalLifecycleMachine, {
    input: {
      candidate,
      budgets: investigationBudgets(policy?.investigationBudgets),
    },
  }).start();
  actor.send({ type: "CLASSIFY" });
  actor.send({ type: "ROUTE" });
  activeInvestigations.set(candidate.auditLineage.signalId, {
    actor,
    startedAt: Date.now(),
  });
  return String(actor.getSnapshot().value);
}

async function queueDigest(
  input: RouteInput,
  decision: PolicyDecision,
): Promise<void> {
  const { getRedisClient } = await import("./channels/redis");
  const redis = getRedisClient();
  if (!redis) throw new Error("telegram_policy_digest_queue_unavailable");
  await redis.rpush(
    "joelclaw:telegram:signal-digest",
    JSON.stringify({
      candidate: toCandidate(input),
      decision,
      queuedAt: new Date().toISOString(),
    }),
  );
}

async function journalSuppression(
  input: RouteInput,
  decision: PolicyDecision,
): Promise<void> {
  await journalMessage({
    messageKey: `telegram:${input.chatId}:${input.audit.flowId}`,
    flowId: input.audit.flowId,
    direction: "outbound",
    eventType: "delivery.suppressed",
    contentKind: input.contentKind ?? "text",
    producer: input.audit.producer,
    originSystemId: input.audit.originSystemId,
    sourceEventId: input.audit.eventId,
    sourceRef: input.policy?.sourceEventType,
    route: input.audit.route,
    classification: decision.category,
    reason: decision.reason,
    investigationState: "suppressed",
    telegramChatId: input.chatId,
    inReplyToMessageId: input.audit.inReplyToMessageId,
    text: input.content,
    transportText: input.transportText ?? input.content,
    deliveryState: "suppressed",
    metadata: {
      sourceClassification: input.policy?.sourceClassification,
      sourceReason: input.policy?.sourceReason,
      policyDisposition: decision.disposition,
    },
  });
}

const defaultDependencies: PolicyRuntimeDependencies = {
  queueDigest,
  journalSuppression,
};

export async function routeTelegramOutbound(
  input: RouteInput,
  dependencies: PolicyRuntimeDependencies = defaultDependencies,
): Promise<TelegramOutboundRoute> {
  const candidate = toCandidate(input);
  const exemption = input.policy?.exemption;
  const exemptionMatchesTarget = exemption?.kind === "specialized-ui"
    || (exemption?.kind === "conversation-reply" && exemption.chatId === input.chatId);
  const decision = exemption && exemptionMatchesTarget
    ? exemptionDecision(input, exemption)
    : telegramOutboundPolicy(candidate);

  let lifecycleState: string | undefined;
  try {
    if (decision.disposition === "investigate") {
      lifecycleState = spawnInvestigation(candidate, input.policy);
    } else if (decision.disposition === "digest") {
      await dependencies.queueDigest(input, decision);
    } else if (decision.disposition === "suppress") {
      await dependencies.journalSuppression(input, decision);
    }
  } catch (error) {
    void emitGatewayOtel({
      level: "error",
      component: "telegram-outbound-policy",
      action: `telegram.policy.${decision.disposition}.failed`,
      success: false,
      error: error instanceof Error ? error.name : "TelegramPolicyRouteError",
      metadata: {
        flowId: input.audit.flowId,
        producer: input.audit.producer,
        disposition: decision.disposition,
        category: decision.category,
        reason: decision.reason,
      },
    });
  }

  void emitGatewayOtel({
    level: "info",
    component: "telegram-outbound-policy",
    action: "telegram.policy.decided",
    success: true,
    metadata: {
      flowId: input.audit.flowId,
      producer: input.audit.producer,
      disposition: decision.disposition,
      category: decision.category,
      reason: decision.reason,
      ...(lifecycleState ? { lifecycleState } : {}),
      ...(input.policy?.exemption
        ? { exemption: input.policy.exemption.marker }
        : {}),
    },
  });

  return {
    disposition: decision.disposition,
    decision,
    ...(lifecycleState ? { lifecycleState } : {}),
  };
}

export const __telegramOutboundPolicyTestUtils = {
  activeInvestigationState(signalId: string): string | undefined {
    const entry = activeInvestigations.get(signalId);
    return entry ? String(entry.actor.getSnapshot().value) : undefined;
  },
  clearInvestigations(): void {
    for (const entry of activeInvestigations.values()) entry.actor.stop();
    activeInvestigations.clear();
  },
};
