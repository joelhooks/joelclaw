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
    match: { action: "content_sync.completed", error: /changes_not_committed/iu },
    tier: 1,
    handler: "autoCommitAndRetry",
    dedup_hours: 24,
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

  // Tier 2: note + batch
  {
    match: { action: "observe.store.failed" },
    tier: 2,
    dedup_hours: 4,
    escalate_after: 10,
  },

  // Tier 3: immediate escalation
  {
    match: { level: "fatal" },
    tier: 3,
    dedup_hours: 1,
  },
];

function matchesPattern(event: OtelEvent, pattern: TriagePattern): boolean {
  const { match } = pattern;
  if (match.component && match.component !== event.component) return false;
  if (match.action && match.action !== event.action) return false;
  if (match.level && match.level !== event.level) return false;
  if (match.error && !match.error.test(event.error ?? "")) return false;
  return true;
}

export function classifyEvent(event: OtelEvent): { tier: 1 | 2 | 3; pattern?: TriagePattern } {
  let matched: { tier: 1 | 2 | 3; pattern?: TriagePattern } | null = null;
  for (const pattern of TRIAGE_PATTERNS) {
    if (matchesPattern(event, pattern)) {
      if (!matched || pattern.tier > matched.tier) {
        matched = { tier: pattern.tier, pattern };
      }
    }
  }
  return matched ?? { tier: 2 };
}

export function dedupKey(event: OtelEvent): string {
  const normalized = JSON.stringify({
    component: event.component,
    action: event.action,
    error: event.error ?? "",
  });
  return createHash("sha256").update(normalized).digest("hex");
}
