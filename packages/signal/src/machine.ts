import { assign, setup } from "xstate";
import { meetsImmediateEscalationGate } from "./escalation";
import { telegramOutboundPolicy } from "./policy";
import type {
  BudgetBlockReason,
  InvestigationUsage,
  MutationAuthority,
  SignalLifecycleContext,
  SignalLifecycleEvent,
  SignalLifecycleInput,
} from "./types";

const EMPTY_USAGE: InvestigationUsage = {
  elapsedMs: 0,
  retriesUsed: 0,
  spendUsdUsed: 0,
};

const authorityRank: Record<MutationAuthority, number> = {
  none: 0,
  read: 1,
  "safe-recovery": 2,
};

function mutationIsWithinBudget(
  context: SignalLifecycleContext,
  event: SignalLifecycleEvent,
): boolean {
  if (event.type !== "REQUEST_MUTATION") return false;
  const authorityAllowed =
    authorityRank[event.authority] <= authorityRank[context.budgets.mutationAuthority];
  const scopeAllowed =
    context.budgets.scope.includes("*") || context.budgets.scope.includes(event.scope);
  return authorityAllowed && scopeAllowed;
}

function mutationBlockReason(
  context: SignalLifecycleContext,
  event: SignalLifecycleEvent,
): BudgetBlockReason {
  if (event.type !== "REQUEST_MUTATION") return "mutation-authority-denied";
  if (authorityRank[event.authority] > authorityRank[context.budgets.mutationAuthority]) {
    return "mutation-authority-denied";
  }
  return "scope-denied";
}

function escalationRequestIsQualified(event: SignalLifecycleEvent): boolean {
  return event.type === "ESCALATE" && meetsImmediateEscalationGate(event.request);
}

export const signalLifecycleMachine = setup({
  types: {
    context: {} as SignalLifecycleContext,
    events: {} as SignalLifecycleEvent,
    input: {} as SignalLifecycleInput,
  },
  delays: {
    snoozeTimer: ({ context }) => Math.max(0, context.snoozeDelayMs ?? 0),
  },
  guards: {
    sameSignal: ({ context, event }) =>
      event.type === "DUPLICATE_DETECTED" && event.signalId === context.signalId,
    routeToInvestigation: ({ context }) => context.decision?.disposition === "investigate",
    routeToDigest: ({ context }) => context.decision?.disposition === "digest",
    routeToDelivery: ({ context }) => context.decision?.disposition === "deliver",
    routeToSuppression: ({ context }) => context.decision?.disposition === "suppress",
    retryWithinBudget: ({ context, event }) =>
      event.type === "RETRY" && context.usage.retriesUsed + 1 <= context.budgets.retries,
    spendWithinBudget: ({ context, event }) =>
      event.type === "SPEND"
      && Number.isFinite(event.amountUsd)
      && event.amountUsd >= 0
      && context.usage.spendUsdUsed + event.amountUsd <= context.budgets.spendUsd,
    timeWithinBudget: ({ context, event }) =>
      event.type === "ELAPSE"
      && Number.isFinite(event.elapsedMs)
      && event.elapsedMs >= 0
      && context.usage.elapsedMs + event.elapsedMs <= context.budgets.timeMs,
    mutationWithinBudget: ({ context, event }) => mutationIsWithinBudget(context, event),
    escalationGate: ({ event }) => escalationRequestIsQualified(event),
    validSnooze: ({ event }) =>
      event.type === "SNOOZE" && Number.isFinite(event.delayMs) && event.delayMs >= 0,
  },
  actions: {
    classify: assign({
      decision: ({ context }) => telegramOutboundPolicy(context.candidate),
    }),
    collapseDuplicate: assign({
      duplicateCount: ({ context }) => context.duplicateCount + 1,
    }),
    recordCancellation: assign({
      cancellationReason: ({ context, event }) =>
        event.type === "CANCEL" ? event.reason : context.cancellationReason,
    }),
    consumeRetry: assign({
      usage: ({ context }) => ({
        ...context.usage,
        retriesUsed: context.usage.retriesUsed + 1,
      }),
    }),
    consumeSpend: assign({
      usage: ({ context, event }) => ({
        ...context.usage,
        spendUsdUsed:
          event.type === "SPEND"
            ? context.usage.spendUsdUsed + event.amountUsd
            : context.usage.spendUsdUsed,
      }),
    }),
    consumeTime: assign({
      usage: ({ context, event }) => ({
        ...context.usage,
        elapsedMs:
          event.type === "ELAPSE"
            ? context.usage.elapsedMs + event.elapsedMs
            : context.usage.elapsedMs,
      }),
    }),
    blockOnRetryBudget: assign({
      blockReason: "retry-budget-exhausted" as const,
    }),
    blockOnSpendBudget: assign({
      blockReason: "spend-budget-exhausted" as const,
    }),
    blockOnTimeBudget: assign({
      blockReason: "time-budget-exhausted" as const,
    }),
    blockOnMutationBudget: assign({
      blockReason: ({ context, event }) => mutationBlockReason(context, event),
    }),
    recordBlock: assign({
      blockReason: "investigation-blocked" as const,
      escalationRequest: ({ context, event }) =>
        event.type === "BLOCK" ? event.request : context.escalationRequest,
    }),
    recordVerifiedImpact: assign({
      escalationRequest: ({ context, event }) =>
        event.type === "VERIFY_IMPACT" ? event.request : context.escalationRequest,
    }),
    recordEscalation: assign({
      escalationRequest: ({ context, event }) =>
        event.type === "ESCALATE" ? event.request : context.escalationRequest,
    }),
    recordDeniedEscalation: assign({
      escalationDeniedCount: ({ context }) => context.escalationDeniedCount + 1,
    }),
    scheduleSnooze: assign({
      snoozeDelayMs: ({ context, event }) =>
        event.type === "SNOOZE" ? event.delayMs : context.snoozeDelayMs,
    }),
    redetect: assign({
      decision: undefined,
      usage: () => ({ ...EMPTY_USAGE }),
      escalationRequest: undefined,
      blockReason: undefined,
      snoozeDelayMs: undefined,
    }),
  },
}).createMachine({
  id: "signalLifecycle",
  context: ({ input }) => ({
    candidate: input.candidate,
    signalId: input.candidate.auditLineage.signalId,
    budgets: {
      ...input.budgets,
      scope: [...input.budgets.scope],
    },
    usage: { ...EMPTY_USAGE },
    duplicateCount: 0,
    escalationDeniedCount: 0,
  }),
  initial: "detected",
  on: {
    DUPLICATE_DETECTED: {
      guard: "sameSignal",
      actions: "collapseDuplicate",
    },
    CANCEL: {
      target: "#signalLifecycle.cancelled",
      actions: "recordCancellation",
    },
  },
  states: {
    detected: {
      on: {
        CLASSIFY: {
          target: "classified",
          actions: "classify",
        },
      },
    },
    classified: {
      on: {
        ROUTE: [
          { target: "investigating", guard: "routeToInvestigation" },
          { target: "digestQueued", guard: "routeToDigest" },
          { target: "delivered", guard: "routeToDelivery" },
          { target: "suppressed", guard: "routeToSuppression" },
          { target: "investigating" },
        ],
      },
    },
    investigating: {
      on: {
        RETRY: [
          { guard: "retryWithinBudget", actions: "consumeRetry" },
          { target: "blocked", actions: "blockOnRetryBudget" },
        ],
        SPEND: [
          { guard: "spendWithinBudget", actions: "consumeSpend" },
          { target: "blocked", actions: "blockOnSpendBudget" },
        ],
        ELAPSE: [
          { guard: "timeWithinBudget", actions: "consumeTime" },
          { target: "blocked", actions: "blockOnTimeBudget" },
        ],
        REQUEST_MUTATION: [
          { guard: "mutationWithinBudget" },
          { target: "blocked", actions: "blockOnMutationBudget" },
        ],
        RESOLVE: "resolved",
        BLOCK: {
          target: "blocked",
          actions: "recordBlock",
        },
        VERIFY_IMPACT: {
          target: "verifiedImpact",
          actions: "recordVerifiedImpact",
        },
      },
    },
    resolved: {
      on: {
        QUEUE_DIGEST: "digestQueued",
        EMIT_RECOVERY_RECEIPT: "recoveryReceipt",
      },
    },
    blocked: {
      on: {
        ESCALATE: [
          {
            target: "escalated",
            guard: "escalationGate",
            actions: "recordEscalation",
          },
          { actions: "recordDeniedEscalation" },
        ],
        QUEUE_DIGEST: "digestQueued",
      },
    },
    verifiedImpact: {
      on: {
        ESCALATE: [
          {
            target: "escalated",
            guard: "escalationGate",
            actions: "recordEscalation",
          },
          { target: "investigating", actions: "recordDeniedEscalation" },
        ],
      },
    },
    escalated: {
      on: {
        DELIVER: "delivered",
      },
    },
    recoveryReceipt: {
      on: {
        DELIVER: "delivered",
      },
    },
    delivered: {
      on: {
        ACKNOWLEDGE: "acknowledged",
        SNOOZE: {
          target: "snoozed",
          guard: "validSnooze",
          actions: "scheduleSnooze",
        },
        DONE: "done",
      },
    },
    snoozed: {
      after: {
        snoozeTimer: {
          target: "detected",
          actions: "redetect",
        },
      },
    },
    digestQueued: { type: "final" },
    suppressed: { type: "final" },
    acknowledged: { type: "final" },
    done: { type: "final" },
    cancelled: { type: "final" },
  },
});
