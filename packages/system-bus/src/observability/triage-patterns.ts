import { createHash } from "node:crypto";
import type { OtelEvent } from "./otel-event";

export type TriagePattern = {
  match: {
    component?: string;
    action?: string;
    error?: RegExp;
    level?: OtelEvent["level"];
  };
  tier: 1 | 2 | 3;
  handler?: string;
  dedup_hours: number;
  escalate_after?: number;
};

export const TRIAGE_PATTERNS: TriagePattern[] = [
  // Tier 1: auto-fix or ignore
  {
    // Content sync can intentionally skip commits when safety gate blocks push.
    // Keep this visible as Tier 2 signal, but never auto-commit from triage.
    match: { action: "content_sync.completed", error: /changes_not_committed/iu },
    tier: 2,
    dedup_hours: 6,
    escalate_after: 20,
  },
  {
    match: { action: "telegram.send.skipped", error: /bot_not_started/iu },
    tier: 1,
    handler: "ignore",
    dedup_hours: 1,
  },
  {
    match: { component: "command-queue", error: /already processing/iu },
    tier: 1,
    handler: "ignore",
    dedup_hours: 1,
  },
  {
    match: { action: "probe.emit" },
    tier: 1,
    handler: "ignore",
    dedup_hours: 24,
  },
  {
    match: { component: "o11y-triage", action: "auto_fix.applied" },
    tier: 1,
    handler: "ignore",
    dedup_hours: 1,
  },
  {
    match: {
      component: "check-system-health",
      action: "system.health.critical_failure",
      error: /\bworker\b/iu,
    },
    tier: 1,
    handler: "restartWorker",
    dedup_hours: 1,
  },

  // Tier 2: note + batch
  {
    match: { action: "observe.store.failed" },
    tier: 2,
    dedup_hours: 4,
    escalate_after: 10,
  },
  {
    match: {
      component: "check-system-health",
      action: "memory.write_gate_drift.detected",
    },
    tier: 2,
    dedup_hours: 6,
    escalate_after: 5,
  },

  // Tier 3: immediate escalation
  {
    match: { level: "fatal" },
    tier: 3,
    dedup_hours: 1,
  },
];

function patternSpecificity(pattern: TriagePattern): number {
  const { match } = pattern;
  let score = 0;
  if (match.component) score += 1;
  if (match.action) score += 1;
  if (match.error) score += 1;
  if (match.level) score += 1;
  return score;
}

function matchesPattern(event: OtelEvent, pattern: TriagePattern): boolean {
  const { match } = pattern;
  if (match.component && match.component !== event.component) return false;
  if (match.action && match.action !== event.action) return false;
  if (match.level && match.level !== event.level) return false;
  if (match.error && !match.error.test(event.error ?? "")) return false;
  return true;
}

export function classifyEvent(event: OtelEvent): { tier: 1 | 2 | 3; pattern?: TriagePattern } {
  let matched: { pattern: TriagePattern; specificity: number } | null = null;
  for (const pattern of TRIAGE_PATTERNS) {
    if (!matchesPattern(event, pattern)) continue;
    const specificity = patternSpecificity(pattern);
    if (!matched) {
      matched = { pattern, specificity };
      continue;
    }
    if (specificity > matched.specificity) {
      matched = { pattern, specificity };
      continue;
    }
    if (specificity === matched.specificity && pattern.tier > matched.pattern.tier) {
      matched = { pattern, specificity };
    }
  }
  return matched ? { tier: matched.pattern.tier, pattern: matched.pattern } : { tier: 2 };
}

export function dedupKey(event: OtelEvent): string {
  const normalized = JSON.stringify({
    component: event.component,
    action: event.action,
    error: event.error ?? "",
  });
  return createHash("sha256").update(normalized).digest("hex");
}
