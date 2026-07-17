import {
  decodeInboundEvent,
  type InboundReactionEventType,
  MESSAGE_REACTION_RECEIVED,
  type MessageReactionReceivedEventType,
} from "@joelclaw/message-contract";
import { NonRetriableError } from "inngest";
import {
  buildReactionReceivedEnvelope,
  gradeNeatMemoryReaction,
  isAuthorizedJoelReaction,
  type NeatMemoryGradeResult,
  type ReactionFlowCorrelation,
  type RedisFlowReader,
  resolveReactionFlow,
} from "../../lib/message-reactions";
import { getRedisClient } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

interface MessageReactionBridgeDependencies {
  readonly redis: () => RedisFlowReader;
  readonly resolveFlow: (
    reaction: InboundReactionEventType,
    redis: RedisFlowReader,
  ) => Promise<ReactionFlowCorrelation | undefined>;
  readonly emit: (input: Parameters<typeof emitOtelEvent>[0]) => Promise<unknown>;
}

interface NeatMemoryReactionGradeDependencies {
  readonly grade: (
    reaction: MessageReactionReceivedEventType["data"],
  ) => Promise<NeatMemoryGradeResult>;
  readonly emit: (input: Parameters<typeof emitOtelEvent>[0]) => Promise<unknown>;
}

const bridgeDefaults: MessageReactionBridgeDependencies = {
  redis: getRedisClient,
  resolveFlow: resolveReactionFlow,
  emit: emitOtelEvent,
};

const gradeDefaults: NeatMemoryReactionGradeDependencies = {
  grade: gradeNeatMemoryReaction,
  emit: emitOtelEvent,
};

export function createMessageReactionBridgeFunction(
  dependencies: MessageReactionBridgeDependencies = bridgeDefaults,
) {
  return inngest.createFunction(
    {
      id: "message/reaction-bridge",
      name: "Message Reaction Bridge",
      idempotency: "event.data.audit.rawEventId",
    },
    { event: "message/inbound.reaction" },
    async ({ event, step }) => {
      let reaction;
      try {
        const decoded = decodeInboundEvent(event.data);
        if (decoded.type !== "reaction") {
          throw new Error(`Expected reaction, received ${decoded.type}`);
        }
        if (!decoded.audit.rawEventId) {
          throw new Error("Inbound reaction is missing audit.rawEventId");
        }
        reaction = decoded;
      } catch (error) {
        throw new NonRetriableError(
          error instanceof Error ? error.message : "Invalid inbound reaction",
        );
      }

      if (!isAuthorizedJoelReaction(reaction)) {
        await step.run("emit-rejected-reaction", () =>
          dependencies.emit({
            level: "warn",
            source: "worker",
            component: "message-reaction-bridge",
            action: "message.reaction.authorization_rejected",
            success: true,
            metadata: {
              platform: reaction.platform,
              rawEventId: reaction.audit.rawEventId,
              authorizationReason: reaction.authorization.reason,
            },
          }));
        return {
          status: "ignored",
          reason: "unauthorized-actor",
          rawEventId: reaction.audit.rawEventId,
        };
      }

      const correlation = await step.run("resolve-platform-message-flow", () =>
        dependencies.resolveFlow(reaction, dependencies.redis()));

      if (!correlation) {
        await step.run("emit-unresolved-correlation", () =>
          dependencies.emit({
            level: "warn",
            source: "worker",
            component: "message-reaction-bridge",
            action: "message.reaction.correlation_unresolved",
            success: true,
            metadata: {
              platform: reaction.platform,
              platformMessageId: reaction.platformIds.messageId,
              rawEventId: reaction.audit.rawEventId,
            },
          }));
        return {
          status: "ignored",
          reason: "flow-unresolved",
          rawEventId: reaction.audit.rawEventId,
        };
      }

      const outgoing = buildReactionReceivedEnvelope(reaction, correlation);
      await step.sendEvent("publish-reaction-received", outgoing);
      await step.run("emit-reaction-bridge-receipt", () =>
        dependencies.emit({
          level: "info",
          source: "worker",
          component: "message-reaction-bridge",
          action: "message.reaction.received_published",
          success: true,
          metadata: {
            flowId: outgoing.data.flowId,
            platform: outgoing.data.platform,
            platformMessageId: outgoing.data.platformMessageId,
            rawEventId: outgoing.data.rawEventId,
            correlationSource: outgoing.data.correlationSource,
            added: outgoing.data.added,
          },
        }));

      return {
        status: "published",
        flowId: outgoing.data.flowId,
        rawEventId: outgoing.data.rawEventId,
        correlationSource: outgoing.data.correlationSource,
      };
    },
  );
}

export function createNeatMemoryReactionGradeFunction(
  dependencies: NeatMemoryReactionGradeDependencies = gradeDefaults,
) {
  return inngest.createFunction(
    {
      id: "message/neat-memory-reaction-grade",
      name: "Neat Memory Reaction Grade",
      idempotency: "event.data.rawEventId",
      concurrency: { limit: 1, key: '"neat-memory-state"' },
    },
    { event: MESSAGE_REACTION_RECEIVED },
    async ({ event, step }) => {
      const result = await step.run("grade-neat-memory", () =>
        dependencies.grade(event.data));

      await step.run("emit-neat-memory-grade-receipt", () =>
        dependencies.emit({
          level: "info",
          source: "worker",
          component: "neat-memory-reaction-grade",
          action: result.status === "graded"
            ? "message.neat_memory.graded"
            : "message.neat_memory.grade_ignored",
          success: true,
          metadata: {
            flowId: event.data.flowId,
            rawEventId: event.data.rawEventId,
            status: result.status,
            ...(result.status === "ignored"
              ? { reason: result.reason }
              : { slug: result.slug, outcome: result.outcome }),
          },
        }));

      return result;
    },
  );
}

export const messageReactionBridge = createMessageReactionBridgeFunction();
export const neatMemoryReactionGrade = createNeatMemoryReactionGradeFunction();
