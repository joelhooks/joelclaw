import type {
  OutboundCandidate,
  PolicyDecision,
  SignalCategory,
  TelegramOutboundPolicy,
} from "./types";

const NOISE_PATTERN = /(?:^|[./_-])(heartbeat|health[-_.]?ok|probe[-_.]?ok|typing|poll|canary)(?:$|[./_-])/i;
const MEMORY_PATTERN = /(?:^|[./_-])memor(?:y|ies)(?:$|[./_-])/i;
const REMINDER_PATTERN = /(?:^|[./_-])reminder(?:$|[./_-])/i;
const ACTION_PATTERN = /(?:approval|action[-_.]?(?:required|needed)|decision[-_.]?(?:required|needed)|joel[-_.]?action)/i;
const RECOVERY_PATTERN = /(?:recover(?:ed|y)?|restored|remediated|healthy[-_.]?again|recovery[-_.]?receipt)/i;
const VERIFIED_RECOVERY_PATTERN = /(?:verified|proof|readback|health(?:y)?|confirmed)/i;
const INFRA_PATTERN = /(?:failed?|failure|error|degrad(?:ed|ation)|fatal|incident|outage|infra|health[-_.]?(?:failed|error)|verify[-_.]?voice)/i;
const ESCALATION_PATTERN = /(?:escalat(?:e|ed|ion)|sos|page[-_.]?operator)/i;

function decision(
  candidate: OutboundCandidate,
  disposition: PolicyDecision["disposition"],
  category: SignalCategory,
  reason: string,
): PolicyDecision {
  return {
    disposition,
    category,
    reason,
    producer: candidate.producer.trim() || "unknown",
  };
}

function unclassifiableFields(candidate: OutboundCandidate): string[] {
  const missing: string[] = [];
  if (!candidate.content?.trim()) missing.push("content");
  if (!candidate.producer?.trim()) missing.push("producer");
  if (!candidate.sourceEventType?.trim()) missing.push("source-event-type");
  if (!candidate.auditLineage?.signalId?.trim()) missing.push("signal-id");
  return missing;
}

/**
 * Required outbound choke-point policy. It fails closed into investigation:
 * unknown or incomplete input is never silently delivered.
 */
export const telegramOutboundPolicy: TelegramOutboundPolicy = (
  candidate,
): PolicyDecision => {
  const missing = unclassifiableFields(candidate);
  if (missing.length > 0) {
    return decision(
      candidate,
      "investigate",
      "noise",
      `investigate.unclassifiable.missing-${missing.join("-")}`,
    );
  }

  const source = candidate.sourceEventType.trim();
  const content = candidate.content.trim();
  const evidence = `${source}\n${content}`;

  if (NOISE_PATTERN.test(source)) {
    return decision(candidate, "suppress", "noise", "suppress.routine-machine-noise");
  }

  if (MEMORY_PATTERN.test(source)) {
    return decision(candidate, "digest", "memory", "digest.memory-candidate");
  }

  if (REMINDER_PATTERN.test(source)) {
    return decision(candidate, "deliver", "reminder", "deliver.quality-reminder");
  }

  if (ACTION_PATTERN.test(source)) {
    return decision(candidate, "deliver", "action", "deliver.joel-owned-action");
  }

  if (ESCALATION_PATTERN.test(source)) {
    return decision(
      candidate,
      "investigate",
      "escalation",
      "investigate.infrastructure-or-escalation-signal",
    );
  }

  const sourceIsRecovery = RECOVERY_PATTERN.test(source) && !INFRA_PATTERN.test(source);
  if (!sourceIsRecovery && INFRA_PATTERN.test(evidence)) {
    return decision(
      candidate,
      "investigate",
      "infra",
      "investigate.infrastructure-or-escalation-signal",
    );
  }

  if (RECOVERY_PATTERN.test(evidence)) {
    const verified = VERIFIED_RECOVERY_PATTERN.test(evidence);
    const immediate = candidate.priority === "urgent" || candidate.priority === "high";
    if (verified && immediate) {
      return decision(
        candidate,
        "deliver",
        "recovery-receipt",
        "deliver.verified-user-impacting-recovery",
      );
    }
    return decision(
      candidate,
      "digest",
      "recovery-receipt",
      verified ? "digest.verified-routine-recovery" : "digest.unverified-recovery-candidate",
    );
  }

  if (
    ESCALATION_PATTERN.test(evidence)
    || INFRA_PATTERN.test(evidence)
    || candidate.level === "error"
    || candidate.level === "fatal"
  ) {
    return decision(
      candidate,
      "investigate",
      ESCALATION_PATTERN.test(evidence) ? "escalation" : "infra",
      "investigate.infrastructure-or-escalation-signal",
    );
  }

  return decision(
    candidate,
    "investigate",
    "noise",
    "investigate.unclassifiable.no-policy-match",
  );
};
