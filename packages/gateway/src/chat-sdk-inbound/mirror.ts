import type { InboundEvent } from "@joelclaw/message-contract";
import {
  diffInboundDecision,
  type InboundDiffReport,
  type LegacyInboundDecision,
} from "./diff";
import {
  type ChatSdkRawNormalizer,
  type NormalizeInboundOptions,
  normalizeRawInbound,
  type RawInboundEnvelope,
} from "./normalize";
import type { ObserveOnlyInboundPublisher } from "./publish";

export interface InboundMirrorTapInput {
  readonly raw: RawInboundEnvelope;
  readonly legacyDecision: LegacyInboundDecision;
}

export type InboundMirrorTapResult =
  | {
      readonly status: "mirrored";
      readonly events: ReadonlyArray<InboundEvent>;
      readonly diffs: ReadonlyArray<InboundDiffReport>;
    }
  | {
      readonly status: "failed-open";
      readonly error: string;
      readonly publishedEventIds: ReadonlyArray<string>;
      readonly publishedDiffReportIds: ReadonlyArray<string>;
    };

export interface InboundMirrorDependencies {
  readonly sdkNormalize: ChatSdkRawNormalizer;
  readonly normalizeOptions: NormalizeInboundOptions;
  readonly publisher: ObserveOnlyInboundPublisher;
  readonly now?: () => Date;
  readonly onError?: (
    error: unknown,
    input: InboundMirrorTapInput,
  ) => void | Promise<void>;
}

/**
 * The sole in-process shadow seam. Existing channel owners call this with the
 * raw event they already received. It normalizes, publishes, and diffs only:
 * no command queue, agent session, callback, or channel action is reachable.
 */
export function createInboundMirrorTap(dependencies: InboundMirrorDependencies) {
  return async function mirrorInbound(
    input: InboundMirrorTapInput,
  ): Promise<InboundMirrorTapResult> {
    const publishedEventIds: string[] = [];
    const publishedDiffReportIds: string[] = [];
    try {
      const events = await normalizeRawInbound(
        input.raw,
        dependencies.sdkNormalize,
        dependencies.normalizeOptions,
      );
      const diffs: InboundDiffReport[] = [];

      for (const event of events) {
        const report = diffInboundDecision(
          input.legacyDecision,
          event,
          dependencies.now,
        );
        await dependencies.publisher.publishEvent(event);
        publishedEventIds.push(event.eventId);
        await dependencies.publisher.publishDiff(report);
        publishedDiffReportIds.push(report.reportId);
        diffs.push(report);
      }

      return { status: "mirrored", events, diffs };
    } catch (error) {
      try {
        await dependencies.onError?.(error, input);
      } catch {
        // Shadow diagnostics must never take down the legacy listener owner.
      }
      return {
        status: "failed-open",
        error: error instanceof Error ? error.message : String(error),
        publishedEventIds,
        publishedDiffReportIds,
      };
    }
  };
}

export type InboundMirrorTap = ReturnType<typeof createInboundMirrorTap>;
