export const SYSTEM_HEALTH_LATCH_SCHEMA = "system-health-latch.v1" as const;
export const SYSTEM_HEALTH_DAILY_SCHEMA = "system-health-daily.v1" as const;
export const SYSTEM_HEALTH_TIME_ZONE = "America/Los_Angeles" as const;

export type HealthAnomalySeverity = "warning" | "critical";
export type HealthTransition =
  | "opened"
  | "changed"
  | "improved"
  | "repeated"
  | "resolved";
export type DeliverableHealthTransition = Extract<
  HealthTransition,
  "opened" | "changed" | "resolved"
>;

export type HealthServiceObservation = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type HealthAnomalyObservation = {
  anomalyId: string;
  component: string;
  componentKey: string;
  detail: string;
  evidenceShape: string;
  severity: HealthAnomalySeverity;
  worseningRank: number;
};

export type HealthIncidentState = HealthAnomalyObservation & {
  firstObservedAt: string;
  lastObservedAt: string;
  lastDeliveredAt?: string;
  occurrence: number;
  repeatCount: number;
  resolutionDeliveredAt?: string;
  state: "open" | "resolved";
};

export type HealthDeliveryBudget = {
  date: string;
  delivered: Partial<Record<DeliverableHealthTransition, true>>;
  deliveredAt: Partial<Record<DeliverableHealthTransition, string>>;
};

export type SystemHealthLatchState = {
  schema: typeof SYSTEM_HEALTH_LATCH_SCHEMA;
  incidents: Record<string, HealthIncidentState>;
  deliveryBudgets: Record<string, HealthDeliveryBudget>;
  updatedAt: string;
};

export type HealthTransitionDecision = {
  anomalyId: string;
  component: string;
  componentKey: string;
  deliver: boolean;
  deliveryReason:
    | "transition"
    | "daily-transition-slot-used"
    | "aggregate-repeat"
    | "non-material-improvement";
  detail: string;
  evidenceShape: string;
  previousAnomalyId?: string;
  repeatCount: number;
  severity: HealthAnomalySeverity;
  transition: HealthTransition;
};

export type SystemHealthReconciliation = {
  active: HealthAnomalyObservation[];
  decisions: HealthTransitionDecision[];
  nextState: SystemHealthLatchState;
  observedAt: string;
  ptDate: string;
};

export type SystemHealthDailyAggregate = {
  schema: typeof SYSTEM_HEALTH_DAILY_SCHEMA;
  date: string;
  observationCount: number;
  allGreenCount: number;
  degradedCount: number;
  immediateDmCount: number;
  transitions: Record<HealthTransition, number>;
  repeatsByAnomaly: Record<string, number>;
  lastObservedAt: string;
};

const CRITICAL_COMPONENT_KEYS = new Set([
  "redis",
  "inngest",
  "worker",
  "gateway",
  "typesense",
  "kubernetes",
  "agent-secrets",
  "agent-dispatch-canary",
]);
const SYSTEM_HEALTH_DELIVERY_BUDGET_KEY = "system-health";

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function includesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function classifyFailure(input: HealthServiceObservation): {
  anomalyId: string;
  evidenceShape: string;
  worseningRank: number;
} {
  const componentKey = slug(input.name);
  const detail = input.detail?.trim().toLowerCase() ?? "";
  const unreachable = includesAny(detail, [
    /\bunreachable\b/u,
    /\btimeout\b/u,
    /\btimed out\b/u,
    /\beconnrefused\b/u,
    /\bconnection refused\b/u,
  ]);

  if (componentKey === "front-projection") {
    if (unreachable) {
      return {
        anomalyId: "front-projection-stale",
        evidenceShape: "freshness-query-unreachable",
        worseningRank: 3,
      };
    }
    if (includesAny(detail, [/\bno .*timestamp\b/u, /\bmissing\b/u, /\bno plausible\b/u])) {
      return {
        anomalyId: "front-projection-stale",
        evidenceShape: "freshness-receipt-missing",
        worseningRank: 2,
      };
    }
    return {
      anomalyId: "front-projection-stale",
      evidenceShape: "freshness-threshold-exceeded",
      worseningRank: 1,
    };
  }

  if (componentKey === "webhooks") {
    if (unreachable) {
      return {
        anomalyId: "webhooks-unreachable",
        evidenceShape: "endpoint-unreachable",
        worseningRank: 3,
      };
    }
    if (includesAny(detail, [
      /\bproviders?:\s*(none|empty)\b/u,
      /\b0 (registered )?providers?\b/u,
      /\bno providers?\b/u,
    ])) {
      return {
        anomalyId: "webhooks-providers-empty",
        evidenceShape: "providers-empty",
        worseningRank: 2,
      };
    }
    return {
      anomalyId: "webhooks-unhealthy",
      evidenceShape: "health-check-failed",
      worseningRank: 1,
    };
  }

  if (componentKey === "worker") {
    return {
      anomalyId: "worker-unreachable",
      evidenceShape: unreachable ? "all-endpoints-unreachable" : "health-check-failed",
      worseningRank: unreachable ? 3 : 2,
    };
  }

  if (componentKey === "typesense") {
    return {
      anomalyId: "typesense-unhealthy",
      evidenceShape: unreachable ? "endpoint-unreachable" : "health-payload-not-ok",
      worseningRank: unreachable ? 3 : 2,
    };
  }

  if (componentKey === "redis") {
    return {
      anomalyId: "redis-unreachable",
      evidenceShape: unreachable ? "endpoint-unreachable" : "health-check-failed",
      worseningRank: unreachable ? 3 : 2,
    };
  }

  if (componentKey === "inngest") {
    return {
      anomalyId: "inngest-unreachable",
      evidenceShape: unreachable ? "endpoint-unreachable" : "health-check-failed",
      worseningRank: unreachable ? 3 : 2,
    };
  }

  return {
    anomalyId: `${componentKey || "unknown-component"}-unhealthy`,
    evidenceShape: unreachable ? "endpoint-unreachable" : "health-check-failed",
    worseningRank: unreachable ? 3 : 2,
  };
}

export function toHealthAnomaly(
  service: HealthServiceObservation,
): HealthAnomalyObservation | null {
  if (service.ok) return null;
  const componentKey = slug(service.name);
  const failure = classifyFailure(service);
  return {
    ...failure,
    component: service.name,
    componentKey,
    detail: service.detail?.trim() || "health check failed",
    severity: CRITICAL_COMPONENT_KEYS.has(componentKey) ? "critical" : "warning",
  };
}

export function createEmptyHealthLatchState(
  observedAt: string,
): SystemHealthLatchState {
  return {
    schema: SYSTEM_HEALTH_LATCH_SCHEMA,
    incidents: {},
    deliveryBudgets: {},
    updatedAt: observedAt,
  };
}

export function parseHealthLatchState(
  raw: string | null,
  observedAt: string,
): SystemHealthLatchState {
  if (!raw) return createEmptyHealthLatchState(observedAt);
  try {
    const value = JSON.parse(raw) as Partial<SystemHealthLatchState>;
    if (
      value.schema !== SYSTEM_HEALTH_LATCH_SCHEMA
      || !value.incidents
      || typeof value.incidents !== "object"
      || !value.deliveryBudgets
      || typeof value.deliveryBudgets !== "object"
    ) {
      return createEmptyHealthLatchState(observedAt);
    }
    return {
      schema: SYSTEM_HEALTH_LATCH_SCHEMA,
      incidents: value.incidents,
      deliveryBudgets: value.deliveryBudgets,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : observedAt,
    };
  } catch {
    return createEmptyHealthLatchState(observedAt);
  }
}

export function ptDate(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SYSTEM_HEALTH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function previousPtDate(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  return ptDate(date.getTime() - 24 * 60 * 60 * 1000);
}

function openByComponent(
  state: SystemHealthLatchState,
): Map<string, HealthIncidentState> {
  return new Map(
    Object.values(state.incidents)
      .filter((incident) => incident.state === "open")
      .map((incident) => [incident.componentKey, incident]),
  );
}

function claimDeliverySlot(input: {
  budgets: Record<string, HealthDeliveryBudget>;
  date: string;
  observedAt: string;
  transition: DeliverableHealthTransition;
}): boolean {
  const existing = input.budgets[SYSTEM_HEALTH_DELIVERY_BUDGET_KEY];
  const budget = existing?.date === input.date
    ? existing
    : { date: input.date, delivered: {}, deliveredAt: {} };
  budget.deliveredAt ??= {};
  input.budgets[SYSTEM_HEALTH_DELIVERY_BUDGET_KEY] = budget;
  if (budget.delivered[input.transition]) {
    return budget.deliveredAt[input.transition] === input.observedAt;
  }
  budget.delivered[input.transition] = true;
  budget.deliveredAt[input.transition] = input.observedAt;
  return true;
}

function decision(input: {
  anomaly: HealthAnomalyObservation;
  deliver: boolean;
  deliveryReason: HealthTransitionDecision["deliveryReason"];
  previousAnomalyId?: string;
  repeatCount: number;
  transition: HealthTransition;
}): HealthTransitionDecision {
  return {
    anomalyId: input.anomaly.anomalyId,
    component: input.anomaly.component,
    componentKey: input.anomaly.componentKey,
    deliver: input.deliver,
    deliveryReason: input.deliveryReason,
    detail: input.anomaly.detail,
    evidenceShape: input.anomaly.evidenceShape,
    ...(input.previousAnomalyId
      ? { previousAnomalyId: input.previousAnomalyId }
      : {}),
    repeatCount: input.repeatCount,
    severity: input.anomaly.severity,
    transition: input.transition,
  };
}

export function reconcileSystemHealth(input: {
  previous: SystemHealthLatchState | null;
  services: readonly HealthServiceObservation[];
  observedAt: string;
}): SystemHealthReconciliation {
  const date = ptDate(input.observedAt);
  const previous = input.previous ?? createEmptyHealthLatchState(input.observedAt);
  const nextState: SystemHealthLatchState = {
    schema: SYSTEM_HEALTH_LATCH_SCHEMA,
    incidents: structuredClone(previous.incidents),
    deliveryBudgets: structuredClone(previous.deliveryBudgets),
    updatedAt: input.observedAt,
  };
  const previousOpen = openByComponent(previous);
  const active = input.services.flatMap((service) => {
    const anomaly = toHealthAnomaly(service);
    return anomaly ? [anomaly] : [];
  });
  const activeComponents = new Set(active.map((anomaly) => anomaly.componentKey));
  const decisions: HealthTransitionDecision[] = [];

  for (const anomaly of active) {
    const prior = previousOpen.get(anomaly.componentKey);
    if (!prior) {
      const priorOccurrence = previous.incidents[anomaly.anomalyId]?.occurrence ?? 0;
      const canDeliver = claimDeliverySlot({
        budgets: nextState.deliveryBudgets,
        date,
        observedAt: input.observedAt,
        transition: "opened",
      });
      nextState.incidents[anomaly.anomalyId] = {
        ...anomaly,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
        ...(canDeliver ? { lastDeliveredAt: input.observedAt } : {}),
        occurrence: priorOccurrence + 1,
        repeatCount: 0,
        state: "open",
      };
      decisions.push(decision({
        anomaly,
        deliver: canDeliver,
        deliveryReason: canDeliver ? "transition" : "daily-transition-slot-used",
        repeatCount: 0,
        transition: "opened",
      }));
      continue;
    }

    const priorAnomaly = previous.incidents[prior.anomalyId] ?? prior;
    const sameAnomaly = prior.anomalyId === anomaly.anomalyId;
    const severityWorsened =
      prior.severity === "warning" && anomaly.severity === "critical";
    const evidenceChanged = prior.evidenceShape !== anomaly.evidenceShape;
    const materiallyWorse =
      severityWorsened
      || anomaly.worseningRank > prior.worseningRank
      || (!sameAnomaly && anomaly.worseningRank >= prior.worseningRank);

    if (sameAnomaly && !evidenceChanged && !severityWorsened) {
      const repeatCount = prior.repeatCount + 1;
      nextState.incidents[anomaly.anomalyId] = {
        ...priorAnomaly,
        ...anomaly,
        lastObservedAt: input.observedAt,
        repeatCount,
        state: "open",
      };
      decisions.push(decision({
        anomaly,
        deliver: false,
        deliveryReason: "aggregate-repeat",
        repeatCount,
        transition: "repeated",
      }));
      continue;
    }

    if (!sameAnomaly) {
      nextState.incidents[prior.anomalyId] = {
        ...priorAnomaly,
        lastObservedAt: input.observedAt,
        state: "resolved",
      };
    }

    if (materiallyWorse) {
      const canDeliver = claimDeliverySlot({
        budgets: nextState.deliveryBudgets,
        date,
        observedAt: input.observedAt,
        transition: "changed",
      });
      nextState.incidents[anomaly.anomalyId] = {
        ...anomaly,
        firstObservedAt: sameAnomaly ? prior.firstObservedAt : input.observedAt,
        lastObservedAt: input.observedAt,
        ...(canDeliver
          ? { lastDeliveredAt: input.observedAt }
          : prior.lastDeliveredAt
            ? { lastDeliveredAt: prior.lastDeliveredAt }
            : {}),
        occurrence: sameAnomaly
          ? prior.occurrence
          : (previous.incidents[anomaly.anomalyId]?.occurrence ?? 0) + 1,
        repeatCount: prior.repeatCount + 1,
        state: "open",
      };
      decisions.push(decision({
        anomaly,
        deliver: canDeliver,
        deliveryReason: canDeliver ? "transition" : "daily-transition-slot-used",
        previousAnomalyId: prior.anomalyId,
        repeatCount: prior.repeatCount + 1,
        transition: "changed",
      }));
      continue;
    }

    nextState.incidents[anomaly.anomalyId] = {
      ...anomaly,
      firstObservedAt: sameAnomaly ? prior.firstObservedAt : input.observedAt,
      lastObservedAt: input.observedAt,
      ...(prior.lastDeliveredAt ? { lastDeliveredAt: prior.lastDeliveredAt } : {}),
      occurrence: sameAnomaly
        ? prior.occurrence
        : (previous.incidents[anomaly.anomalyId]?.occurrence ?? 0) + 1,
      repeatCount: prior.repeatCount + 1,
      state: "open",
    };
    decisions.push(decision({
      anomaly,
      deliver: false,
      deliveryReason: "non-material-improvement",
      previousAnomalyId: prior.anomalyId,
      repeatCount: prior.repeatCount + 1,
      transition: "improved",
    }));
  }

  for (const prior of previousOpen.values()) {
    if (activeComponents.has(prior.componentKey)) continue;
    const canDeliver = claimDeliverySlot({
      budgets: nextState.deliveryBudgets,
      date,
      observedAt: input.observedAt,
      transition: "resolved",
    });
    nextState.incidents[prior.anomalyId] = {
      ...prior,
      lastObservedAt: input.observedAt,
      ...(canDeliver ? { resolutionDeliveredAt: input.observedAt } : {}),
      state: "resolved",
    };
    decisions.push(decision({
      anomaly: prior,
      deliver: canDeliver,
      deliveryReason: canDeliver ? "transition" : "daily-transition-slot-used",
      repeatCount: prior.repeatCount,
      transition: "resolved",
    }));
  }

  return {
    active,
    decisions,
    nextState,
    observedAt: input.observedAt,
    ptDate: date,
  };
}

export function createEmptyDailyAggregate(date: string): SystemHealthDailyAggregate {
  return {
    schema: SYSTEM_HEALTH_DAILY_SCHEMA,
    date,
    observationCount: 0,
    allGreenCount: 0,
    degradedCount: 0,
    immediateDmCount: 0,
    transitions: {
      opened: 0,
      changed: 0,
      improved: 0,
      repeated: 0,
      resolved: 0,
    },
    repeatsByAnomaly: {},
    lastObservedAt: "",
  };
}

export function parseDailyAggregate(
  raw: string | null,
  date: string,
): SystemHealthDailyAggregate {
  if (!raw) return createEmptyDailyAggregate(date);
  try {
    const value = JSON.parse(raw) as Partial<SystemHealthDailyAggregate>;
    if (
      value.schema !== SYSTEM_HEALTH_DAILY_SCHEMA
      || value.date !== date
      || !value.transitions
    ) {
      return createEmptyDailyAggregate(date);
    }
    return {
      ...createEmptyDailyAggregate(date),
      ...value,
      schema: SYSTEM_HEALTH_DAILY_SCHEMA,
      date,
      transitions: {
        ...createEmptyDailyAggregate(date).transitions,
        ...value.transitions,
      },
      repeatsByAnomaly: value.repeatsByAnomaly ?? {},
    };
  } catch {
    return createEmptyDailyAggregate(date);
  }
}

export function addHealthObservationToDailyAggregate(
  current: SystemHealthDailyAggregate,
  reconciliation: SystemHealthReconciliation,
): SystemHealthDailyAggregate {
  const next = structuredClone(current);
  next.observationCount += 1;
  next.lastObservedAt = reconciliation.observedAt;
  if (reconciliation.active.length === 0) next.allGreenCount += 1;
  else next.degradedCount += 1;
  if (reconciliation.decisions.some((item) => item.deliver)) {
    next.immediateDmCount += 1;
  }
  for (const item of reconciliation.decisions) {
    next.transitions[item.transition] += 1;
    if (!item.deliver) {
      next.repeatsByAnomaly[item.anomalyId] =
        (next.repeatsByAnomaly[item.anomalyId] ?? 0) + 1;
    }
  }
  return next;
}

function incidentLabel(anomalyId: string): string {
  return anomalyId.replaceAll("-", " ");
}

export function formatHealthTransitionMessage(
  decisions: readonly HealthTransitionDecision[],
): string {
  const delivered = decisions.filter((item) => item.deliver);
  const allResolved = delivered.every((item) => item.transition === "resolved");
  const title = allResolved
    ? "✅ System health recovered"
    : delivered.every((item) => item.transition === "opened")
      ? "🚨 System health incident opened"
      : "⚠️ System health changed";
  return [
    title,
    "",
    ...delivered.map((item) =>
      `- ${item.component}: ${item.transition} (${incidentLabel(item.anomalyId)})`
    ),
  ].join("\n");
}

export function formatSystemHealthDailyDigest(input: {
  aggregate: SystemHealthDailyAggregate;
  latchState: SystemHealthLatchState;
}): string {
  const open = Object.values(input.latchState.incidents)
    .filter((incident) => incident.state === "open")
    .sort((left, right) => left.component.localeCompare(right.component));
  const transitions = input.aggregate.transitions;
  return [
    `## System health — ${input.aggregate.date}`,
    "",
    `${input.aggregate.observationCount} checks: ${input.aggregate.allGreenCount} green, ${input.aggregate.degradedCount} degraded.`,
    `Immediate DMs: ${input.aggregate.immediateDmCount}.`,
    `Transitions: ${transitions.opened} opened, ${transitions.changed} changed, ${transitions.resolved} resolved.`,
    `Repeated or improving observations joined the digest: ${transitions.repeated + transitions.improved}.`,
    "",
    open.length === 0
      ? "Open at close: none."
      : `Open at close: ${open.map((incident) => incidentLabel(incident.anomalyId)).join(", ")}.`,
  ].join("\n");
}
