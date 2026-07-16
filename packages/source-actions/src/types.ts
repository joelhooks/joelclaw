import { Data, Effect, Option } from "effect";

export type SourceKind =
  | "todoist"
  | "things"
  | "brain"
  | "front"
  | "gmail"
  | "inngest"
  | "fixture";

export type SourceRef = {
  kind: SourceKind;
  id: string;
  revision?: string;
};

export type SourceItem = {
  ref: SourceRef;
  title: string;
  state: "open" | "resolved";
  semanticAction: "complete" | "archive" | "acknowledge" | "none";
  revision?: string;
  openUrl?: string;
};

export type SourceCapabilities = {
  resolve: {
    supported: boolean;
    idempotency: "native" | "read-before-write" | "none";
    button: "Done" | "Acknowledge";
  };
  acknowledge: boolean;
  snooze: {
    supported: boolean;
    mode: "source" | "local-reminder" | "none";
  };
  openUrl: boolean;
};

export type ActionContext = {
  actionId: string;
  actor: "joel";
  telegramMessageId: number;
  requestedAt: string;
};

export type MutationReceipt = {
  outcome: "applied" | "already-applied";
  sourceId: string;
  sourceRevision?: string;
  openUrl?: string;
  detail: string;
};

export class SourceError extends Data.TaggedError("SourceError")<{
  operation: "inspect" | "resolve" | "acknowledge" | "snooze" | "openUrl";
  message: string;
  ref?: SourceRef;
  cause?: unknown;
}> {}

/**
 * Source-owned action contract. Capabilities are derived from the inspected
 * item so one provider can safely expose different controls per item.
 */
export interface SourceAdapter {
  inspect(ref: SourceRef): Effect.Effect<SourceItem, SourceError>;
  capabilities(item: SourceItem): SourceCapabilities;
  resolve(item: SourceItem, context: ActionContext): Effect.Effect<MutationReceipt, SourceError>;
  acknowledge(item: SourceItem, context: ActionContext): Effect.Effect<MutationReceipt, SourceError>;
  snooze(
    item: SourceItem,
    until: Date,
    context: ActionContext,
  ): Effect.Effect<MutationReceipt, SourceError>;
  openUrl(item: SourceItem): Effect.Effect<Option.Option<string>, SourceError>;
}
