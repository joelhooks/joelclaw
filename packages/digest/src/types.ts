import type {
  ActionOperation,
  ActionRecord,
  MutationReceipt,
  SourceAdapter,
  SourceKind,
  SourceRef,
} from "@joelclaw/source-actions";
import { Data, Effect } from "effect";

export const BRAIN_PUBLICATION_ORIGIN = "https://brain.joelclaw.com";
export const DEFAULT_DIGEST_ACTION_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_DIGEST_SNOOZE_MS = 4 * 60 * 60 * 1_000;

export type DigestMemoryCandidate = {
  kind: "memory";
  summary: string;
  source: string;
  happenedAt: string;
  whyNow: string;
  connection: string;
  quality: "high" | "normal";
  relevance?: number;
  sourceRef?: SourceRef;
  sourceUrl?: string;
};

export type DigestReceiptCandidate = {
  kind: "agent-win" | "recovery-receipt";
  important: boolean;
  summary: string;
  proof: string;
  whatBroke?: string;
  whatFixedIt?: string;
  remainingRisk?: string;
};

export type DigestActionCandidate = {
  kind: "action";
  owner: "joel" | "agent";
  title: string;
  sourceRef: SourceRef;
};

export type DigestReminderCandidate = {
  kind: "reminder";
  owner: "joel" | "agent";
  title: string;
  sourceRef: SourceRef;
  sourceEvidence: string;
  presentRelevance: string;
  dueAt?: string;
  deadlineSource?: "source";
};

export type DigestCandidate =
  | DigestMemoryCandidate
  | DigestReceiptCandidate
  | DigestActionCandidate
  | DigestReminderCandidate;

export type DigestInput = {
  requestedAt: string;
  trigger: "scheduled" | "on-demand";
  candidates: readonly DigestCandidate[];
};

export type DigestActionControl = {
  kind: "action";
  text: string;
  actionId: string;
  operation: Exclude<ActionOperation, "open-url">;
  sourceRef: SourceRef;
};

export type DigestUrlControl = {
  kind: "url";
  text: string;
  url: string;
};

export type DigestControl = DigestActionControl | DigestUrlControl;

/** Matches the gateway Telegram button shape without importing gateway code. */
export type DigestTelegramButton = {
  text: string;
  action?: string;
  url?: string;
};

export type DigestTelegramPayload = {
  text: string;
  format: "html";
  buttons: DigestTelegramButton[][];
  policy: {
    sourceEventType: "signal/digest.assembled";
    priority: "normal";
  };
};

export type DigestReady = {
  kind: "ready";
  payload: DigestTelegramPayload;
  controls: DigestControl[][];
  selectedMemory?: DigestMemoryCandidate;
  includedCandidateCount: number;
  rejected: readonly DigestRejection[];
};

export type DigestEmpty = {
  kind: "empty";
  reason: "no-qualified-content";
  rejected: readonly DigestRejection[];
};

export type DigestResult = DigestReady | DigestEmpty;

export type DigestRejection = {
  kind: DigestCandidate["kind"];
  reason: string;
};

export type DigestLinkVerifier = (
  url: string,
) => Effect.Effect<boolean, DigestError>;

export type DigestAdapterMap = Partial<Record<SourceKind, SourceAdapter>>;

export type DigestActionOutcome =
  | {
      status: "applied" | "already-applied";
      record: ActionRecord;
      receipt: MutationReceipt;
    }
  | {
      status: "failed";
      record: ActionRecord;
      failure: string;
    }
  | {
      status: "expired";
      record: ActionRecord;
    };

export type HandleDigestActionInput = {
  actionId: string;
  telegramMessageId: number;
};

export class DigestError extends Data.TaggedError("DigestError")<{
  operation: "assemble" | "verify-link" | "handle-action" | "refresh-controls";
  message: string;
  actionId?: string;
  sourceRef?: SourceRef;
  cause?: unknown;
}> {}
