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
// The canonical operator lane: `joelclaw notify send` emits notify.message.
const OPERATOR_NOTIFY_PATTERN = /(?:^|[./_-])notify[-_.]?message(?:$|[./_-])/i;
// Raw automated probe results must never page directly, even through the
// operator lane — verify-voice is the chartered anti-pattern.
const PROBE_FAILURE_PATTERN =
  /(?:verify[-_.]?voice|probe[-_.]?(?:failed|failure)|(?:health|recall)[-_.]?check[-_.]?failed|watchdog[-_.]?(?:failed|tripped))/i;
// Producers whose output is already quality-gated upstream: the neat-memory
// curator judges send-vs-hold itself (Joel's 2026-07-16 product decision:
// curator DMs on its own beat, no frequency cap). Policy delivers as memory.
const CURATED_MEMORY_PRODUCER_PATTERN = /^observer[./_-]neat[-_.]?memory$/i;

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

  if (CURATED_MEMORY_PRODUCER_PATTERN.test(candidate.producer)) {
    return decision(candidate, "deliver", "memory", "deliver.curated-memory-dm");
  }

  // Operator-immediate notifications deliver as written. The message body is
  // human prose and MUST NOT be keyword-scanned as if it were a machine
  // signal — an aide's text mentioning "failed" is not an infra event.
  // Narrow exception: raw automated probe failures stay intercepted.
  const operatorImmediate = OPERATOR_NOTIFY_PATTERN.test(source)
    && (candidate.priority === "urgent" || candidate.priority === "high");
  if (operatorImmediate) {
    if (PROBE_FAILURE_PATTERN.test(content)) {
      return decision(
        candidate,
        "investigate",
        "infra",
        "investigate.probe-failure-via-operator-lane",
      );
    }
    return decision(
      candidate,
      "deliver",
      "escalation",
      "deliver.operator-immediate-notification",
    );
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
