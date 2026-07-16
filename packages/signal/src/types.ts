export const POLICY_DISPOSITIONS = ["deliver", "investigate", "digest", "suppress"] as const;
export type PolicyDisposition = (typeof POLICY_DISPOSITIONS)[number];

export const SIGNAL_CATEGORIES = [
  "memory",
  "action",
  "reminder",
  "escalation",
  "recovery-receipt",
  "infra",
  "noise",
] as const;
export type SignalCategory = (typeof SIGNAL_CATEGORIES)[number];

export type SignalLevel = "debug" | "info" | "warn" | "error" | "fatal";
export type SignalPriority = "low" | "normal" | "high" | "urgent";

export type AuditLineage = {
  signalId: string;
  flowId?: string;
  parentFlowId?: string;
  sourceEventId?: string;
};

export type OutboundCandidate = {
  content: string;
  producer: string;
  level?: SignalLevel;
  priority?: SignalPriority;
  sourceEventType: string;
  auditLineage: AuditLineage;
};

export type PolicyDecision = {
  disposition: PolicyDisposition;
  category: SignalCategory;
  reason: string;
  producer: string;
};

export type TelegramOutboundPolicy = (candidate: OutboundCandidate) => PolicyDecision;

export const WAITING_RISKS = [
  "customer-harm",
  "money-loss",
  "security-or-data-loss",
  "blocked-launch-or-system",
  "explicit-joel-commitment",
] as const;
export type WaitingRisk = (typeof WAITING_RISKS)[number];

export const ESCALATION_EVIDENCE = [
  "verified-impact",
  "failed-safe-recovery",
  "joel-decision-or-access-needed",
] as const;
export type EscalationEvidence = (typeof ESCALATION_EVIDENCE)[number];

export type EscalationRequest = {
  waitingRisk: WaitingRisk;
  evidence: EscalationEvidence;
  detail: string;
};

export const MUTATION_AUTHORITIES = ["none", "read", "safe-recovery"] as const;
export type MutationAuthority = (typeof MUTATION_AUTHORITIES)[number];

export type InvestigationBudgets = {
  timeMs: number;
  retries: number;
  spendUsd: number;
  mutationAuthority: MutationAuthority;
  scope: readonly string[];
};

export type InvestigationUsage = {
  elapsedMs: number;
  retriesUsed: number;
  spendUsdUsed: number;
};

export type BudgetBlockReason =
  | "time-budget-exhausted"
  | "retry-budget-exhausted"
  | "spend-budget-exhausted"
  | "mutation-authority-denied"
  | "scope-denied";

export type SignalLifecycleContext = {
  candidate: OutboundCandidate;
  signalId: string;
  decision?: PolicyDecision;
  budgets: InvestigationBudgets;
  usage: InvestigationUsage;
  duplicateCount: number;
  escalationRequest?: EscalationRequest;
  blockReason?: BudgetBlockReason | "investigation-blocked";
  cancellationReason?: string;
  snoozeDelayMs?: number;
  escalationDeniedCount: number;
};

export type SignalLifecycleInput = {
  candidate: OutboundCandidate;
  budgets: InvestigationBudgets;
};

export type SignalLifecycleEvent =
  | { type: "CLASSIFY" }
  | { type: "ROUTE" }
  | { type: "DUPLICATE_DETECTED"; signalId: string }
  | { type: "CANCEL"; reason: string }
  | { type: "RETRY" }
  | { type: "SPEND"; amountUsd: number }
  | { type: "ELAPSE"; elapsedMs: number }
  | { type: "REQUEST_MUTATION"; authority: Exclude<MutationAuthority, "none">; scope: string }
  | { type: "RESOLVE" }
  | { type: "QUEUE_DIGEST" }
  | { type: "EMIT_RECOVERY_RECEIPT" }
  | { type: "BLOCK"; request?: EscalationRequest }
  | { type: "VERIFY_IMPACT"; request: EscalationRequest }
  | { type: "ESCALATE"; request: EscalationRequest }
  | { type: "DELIVER" }
  | { type: "ACKNOWLEDGE" }
  | { type: "SNOOZE"; delayMs: number }
  | { type: "DONE" };
