import type {
  DeliveryReceiptEnvelope,
  MessagePlatformType,
  MessageRouteType,
  OutboundIntent,
} from "@joelclaw/message-contract";
import { decodeOutboundIntent, resolveMessageRoute } from "@joelclaw/message-contract";
import { journalMessage } from "../message-journal";

export const OUTBOUND_SHADOW_FLAG = "CHAT_SDK_OUTBOUND_SHADOW_ENABLED" as const;

export interface LegacyOutboundPreview {
  readonly platform: MessagePlatformType;
  readonly target: string;
  readonly content: string;
  readonly route: MessageRouteType;
}

export interface ShadowMismatch {
  readonly field: "platform" | "target" | "content" | "lane" | "urgency" | "formatting";
  readonly sdk: string;
  readonly legacy: string;
}

export interface OutboundShadowReport {
  readonly enabled: true;
  readonly comparedAt: string;
  readonly correlationId: string;
  readonly sdk: DeliveryReceiptEnvelope;
  readonly sdkTarget: string;
  readonly legacy: LegacyOutboundPreview;
  readonly matches: boolean;
  readonly mismatches: readonly ShadowMismatch[];
}

export interface OutboundShadowSkipped {
  readonly enabled: false;
  readonly reason: "flag-disabled";
}

export interface OutboundShadowDependencies {
  readonly sendSdk: (intent: OutboundIntent) => Promise<DeliveryReceiptEnvelope>;
  readonly previewLegacy: (
    intent: OutboundIntent,
    route: MessageRouteType,
  ) => Promise<LegacyOutboundPreview> | LegacyOutboundPreview;
  readonly resolveSdkTarget: (platform: MessagePlatformType) => string;
  readonly recordComparison?: (report: OutboundShadowReport) => Promise<void>;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
}

export function isOutboundShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OUTBOUND_SHADOW_FLAG]?.trim().toLowerCase() === "true"
    || env[OUTBOUND_SHADOW_FLAG]?.trim() === "1";
}

function compare(
  receipt: DeliveryReceiptEnvelope,
  legacy: LegacyOutboundPreview,
  intent: OutboundIntent,
  sdkTarget: string,
): ShadowMismatch[] {
  const mismatches: ShadowMismatch[] = [];
  const sdkRoute = receipt.data.route;
  const candidates: Array<ShadowMismatch | undefined> = [
    receipt.data.platform === legacy.platform
      ? undefined
      : { field: "platform", sdk: receipt.data.platform, legacy: legacy.platform },
    sdkTarget === legacy.target
      ? undefined
      : { field: "target", sdk: sdkTarget, legacy: legacy.target },
    intent.content === legacy.content
      ? undefined
      : { field: "content", sdk: intent.content, legacy: legacy.content },
    sdkRoute.lane === legacy.route.lane
      ? undefined
      : { field: "lane", sdk: sdkRoute.lane, legacy: legacy.route.lane },
    sdkRoute.urgency === legacy.route.urgency
      ? undefined
      : { field: "urgency", sdk: sdkRoute.urgency, legacy: legacy.route.urgency },
    sdkRoute.formatting === legacy.route.formatting
      ? undefined
      : { field: "formatting", sdk: sdkRoute.formatting, legacy: legacy.route.formatting },
  ];
  for (const candidate of candidates) {
    if (candidate) mismatches.push(candidate);
  }
  return mismatches;
}

export async function recordShadowComparison(
  report: OutboundShadowReport,
  record: typeof journalMessage = journalMessage,
): Promise<void> {
  await record({
    messageKey: `shadow:${report.sdk.data.flowId}`,
    flowId: report.sdk.data.flowId,
    channel: report.sdk.data.platform,
    direction: "interaction",
    eventType: "message.outbound.shadow-compared",
    contentKind: "shadow-diff",
    occurredAt: report.comparedAt,
    producer: "chat-sdk-outbound-shadow-v1",
    originSystemId: report.correlationId,
    route: `${report.sdk.data.route.lane}:${report.sdk.data.route.urgency}:${report.sdk.data.route.formatting}`,
    telegramChatId: report.sdk.data.platform === "telegram"
      ? Number(report.sdk.data.threadId?.split(":")[1] ?? 0)
      : 0,
    telegramMessageId: report.sdk.data.platform === "telegram"
      ? Number(report.sdk.data.platformMessageId?.split(":").at(-1) ?? 0)
      : null,
    deliveryState: report.matches ? "shadow-match" : "shadow-diff",
    metadata: {
      contractVersion: 2,
      matches: report.matches,
      mismatches: report.mismatches,
      sdkPlatformMessageId: report.sdk.data.platformMessageId,
      legacy: report.legacy,
    },
  });
}

export async function runOutboundShadow(
  input: unknown,
  dependencies: OutboundShadowDependencies,
): Promise<OutboundShadowReport | OutboundShadowSkipped> {
  if (!isOutboundShadowEnabled(dependencies.env)) {
    return { enabled: false, reason: "flag-disabled" };
  }

  const intent = decodeOutboundIntent(input);
  const route = resolveMessageRoute(intent.kind);
  const legacy = await dependencies.previewLegacy(intent, route);
  const sdkTarget = dependencies.resolveSdkTarget(route.platform);
  const sdk = await dependencies.sendSdk(intent);
  const mismatches = compare(sdk, legacy, intent, sdkTarget);
  const report: OutboundShadowReport = {
    enabled: true,
    comparedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    correlationId: intent.correlationId,
    sdk,
    sdkTarget,
    legacy,
    matches: mismatches.length === 0,
    mismatches,
  };
  await (dependencies.recordComparison ?? recordShadowComparison)(report);
  return report;
}
