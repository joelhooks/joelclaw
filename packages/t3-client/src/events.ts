/**
 * Normalized gateway events. Plain JSON — no Effect types, no T3 contract
 * types. This is the boundary the rest of joelclaw consumes; T3 vocabulary
 * stays behind it.
 */

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface ThreadSummary {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelInstanceId: string;
  readonly model: string;
  readonly turnState: "running" | "interrupted" | "completed" | "error" | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly updatedAt: string;
}

export interface ProjectSummary {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ShellSnapshot {
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly threads: ReadonlyArray<ThreadSummary>;
}

export type GatewayEvent =
  | { readonly kind: "sync"; readonly threadId: string }
  | {
      readonly kind: "message";
      readonly threadId: string;
      readonly role: string;
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly kind: "activity";
      readonly threadId: string;
      readonly activityKind: string;
      readonly tone: string;
      readonly summary: string;
      readonly payload: unknown;
    }
  | {
      /**
       * Derived from activity events: `approval` from the typed activity tone,
       * `user-input` from the provider's activity kind. `requestId` is the
       * orchestration event's own request id — pass it straight to
       * `respondApproval` / `respondUserInput`. It is optional because not
       * every attention-worthy activity carries one; the raw payload still
       * rides along as the fallback.
       */
      readonly kind: "attention";
      readonly threadId: string;
      readonly reason: "approval" | "user-input";
      readonly summary: string;
      readonly requestId?: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: "turn-settled";
      readonly threadId: string;
      readonly state: "interrupted" | "completed" | "error";
      readonly assistantText: string;
    }
  | { readonly kind: "event"; readonly threadId: string; readonly type: string };
