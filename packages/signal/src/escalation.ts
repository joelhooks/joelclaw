import {
  ESCALATION_EVIDENCE,
  type EscalationRequest,
  WAITING_RISKS,
} from "./types";

const waitingRisks = new Set<string>(WAITING_RISKS);
const escalationEvidence = new Set<string>(ESCALATION_EVIDENCE);

/** Both halves are required: material risk from waiting and concrete evidence or a Joel-owned dependency. */
export function meetsImmediateEscalationGate(request: EscalationRequest): boolean {
  return (
    waitingRisks.has(request.waitingRisk)
    && escalationEvidence.has(request.evidence)
    && request.detail.trim().length > 0
  );
}
