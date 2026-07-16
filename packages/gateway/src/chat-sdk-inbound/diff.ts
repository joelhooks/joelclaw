import { createHash } from "node:crypto";
import type {
  InboundAuthorizationVerdict,
  InboundEvent,
  InboundEventKind,
  InboundPlatform,
  InboundPolicyAction,
} from "@joelclaw/message-contract";

interface LegacyInboundDecisionBase {
  readonly platform: InboundPlatform;
  readonly authorizationVerdict: InboundAuthorizationVerdict;
  readonly policyAction: InboundPolicyAction;
  readonly actorId: string;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly acted: boolean;
  readonly reason: string;
}

export type LegacyInboundDecision = LegacyInboundDecisionBase &
  (
    | { readonly kind: "message"; readonly text: string }
    | {
        readonly kind: "command";
        readonly command: string;
        readonly argumentsText: string;
      }
    | {
        readonly kind: "interaction";
        readonly actionId: string;
        readonly value: string | null;
      }
    | {
        readonly kind: "reaction";
        readonly emoji: string;
        readonly rawEmoji: string;
        readonly added: boolean;
      }
  );

export interface InboundDiffMismatch {
  readonly field: string;
  readonly legacy: string | number | boolean | null;
  readonly sdk: string | number | boolean | null;
}

type SdkInboundDecision = {
  readonly authorizationVerdict: InboundAuthorizationVerdict;
  readonly policyAction: InboundPolicyAction;
  readonly actorId: string;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly wouldAct: boolean;
  readonly actualActed: false;
} &
  (
    | { readonly kind: "message"; readonly text: string }
    | {
        readonly kind: "command";
        readonly command: string;
        readonly argumentsText: string;
      }
    | {
        readonly kind: "interaction";
        readonly actionId: string;
        readonly value: string | null;
      }
    | {
        readonly kind: "reaction";
        readonly emoji: string;
        readonly rawEmoji: string;
        readonly added: boolean;
      }
  );

export interface InboundDiffReport {
  readonly reportVersion: 1;
  readonly reportId: string;
  readonly shadow: true;
  readonly eventId: string;
  readonly platform: InboundPlatform;
  readonly kind: InboundEventKind;
  readonly comparedAt: string;
  readonly parity: boolean;
  readonly mismatches: ReadonlyArray<InboundDiffMismatch>;
  readonly legacy: LegacyInboundDecision;
  readonly sdk: SdkInboundDecision;
}

function toSdkDecision(event: InboundEvent): SdkInboundDecision {
  const base = {
    authorizationVerdict: event.authorization.verdict,
    policyAction: event.authorization.policyAction,
    actorId: event.platformIds.actorId,
    conversationId: event.platformIds.conversationId,
    messageId: event.platformIds.messageId,
    wouldAct:
      event.authorization.verdict === "accepted" &&
      event.authorization.policyAction === "invoke",
    actualActed: false as const,
  };

  switch (event.type) {
    case "message":
      return { ...base, kind: event.type, text: event.text };
    case "command":
      return {
        ...base,
        kind: event.type,
        command: event.command,
        argumentsText: event.argumentsText,
      };
    case "interaction":
      return {
        ...base,
        kind: event.type,
        actionId: event.actionId,
        value: event.value,
      };
    case "reaction":
      return {
        ...base,
        kind: event.type,
        emoji: event.emoji,
        rawEmoji: event.rawEmoji,
        added: event.added,
      };
  }
}

function reportId(eventId: string, legacy: LegacyInboundDecision): string {
  return createHash("sha256")
    .update(JSON.stringify([eventId, legacy]))
    .digest("hex");
}

export function diffInboundDecision(
  legacy: LegacyInboundDecision,
  event: InboundEvent,
  now: () => Date = () => new Date(),
): InboundDiffReport {
  const sdk = toSdkDecision(event);
  const mismatches: InboundDiffMismatch[] = [];
  const compare = (
    field: string,
    legacyValue: string | number | boolean | null,
    sdkValue: string | number | boolean | null,
  ): void => {
    if (legacyValue !== sdkValue) {
      mismatches.push({ field, legacy: legacyValue, sdk: sdkValue });
    }
  };

  compare("platform", legacy.platform, event.platform);
  compare("kind", legacy.kind, event.type);
  compare("authorization.verdict", legacy.authorizationVerdict, sdk.authorizationVerdict);
  compare("authorization.policyAction", legacy.policyAction, sdk.policyAction);
  compare("actorId", legacy.actorId, sdk.actorId);
  compare("conversationId", legacy.conversationId, sdk.conversationId);
  compare("messageId", legacy.messageId, sdk.messageId);
  compare("acted", legacy.acted, sdk.wouldAct);

  switch (legacy.kind) {
    case "message":
      if (sdk.kind === "message") compare("text", legacy.text, sdk.text);
      break;
    case "command":
      if (sdk.kind === "command") {
        compare("command", legacy.command, sdk.command);
        compare("argumentsText", legacy.argumentsText, sdk.argumentsText);
      }
      break;
    case "interaction":
      if (sdk.kind === "interaction") {
        compare("actionId", legacy.actionId, sdk.actionId);
        compare("value", legacy.value, sdk.value);
      }
      break;
    case "reaction":
      if (sdk.kind === "reaction") {
        compare("emoji", legacy.emoji, sdk.emoji);
        compare("rawEmoji", legacy.rawEmoji, sdk.rawEmoji);
        compare("added", legacy.added, sdk.added);
      }
      break;
  }

  const comparedAt = now().toISOString();
  return {
    reportVersion: 1,
    reportId: reportId(event.eventId, legacy),
    shadow: true,
    eventId: event.eventId,
    platform: event.platform,
    kind: event.type,
    comparedAt,
    parity: mismatches.length === 0,
    mismatches,
    legacy,
    sdk,
  };
}
