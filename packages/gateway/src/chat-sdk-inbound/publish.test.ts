import { describe, expect, test } from "bun:test";
import type { InboundEvent } from "@joelclaw/message-contract";
import type { AppendMessageEventInput } from "@joelclaw/message-event-log";
import { createStreamInboundPublisher } from "./publish";

function slackEvent(authorizedJoel: boolean): InboundEvent {
  return {
    platform: "slack",
    type: "message",
    eventId: "slack:message:work-1",
    occurredAt: "2026-08-05T16:00:00.000Z",
    actor: { platformUserId: authorizedJoel ? "UJOEL" : "UTEAM" },
    platformIds: {
      conversationId: "CEXAMPLE",
      messageId: "1785950000.100",
      threadId: null,
    },
    rawAnchors: {
      sourceMessageId: "1785950000.100",
      sourceThreadId: null,
    },
    audit: {
      source: "gateway.slack.chat-sdk.message",
      rawEventId: "1785950000.100",
    },
    authorization: authorizedJoel
      ? { verdict: "accepted", reason: "authorized_joel" }
      : { verdict: "rejected", reason: "non_joel_actor" },
    text: "please review this :shitrat:",
    isMention: false,
  } as unknown as InboundEvent;
}

function harness(input: {
  authorizedJoel: boolean;
  withWorkRequest: boolean;
}) {
  const appended: AppendMessageEventInput[] = [];
  const acknowledged: string[] = [];
  const errors: string[] = [];
  const event = slackEvent(input.authorizedJoel);
  const publisher = createStreamInboundPublisher({
    eventLog: {
      append: async (value) => {
        appended.push(value);
        return {
          eventId: "inbound-1",
          semanticKey: value.semanticKey,
          deduplicated: false,
          schemaVersion: 1,
        };
      },
    },
    resolveFlowId: async () => undefined,
    resolveWorkRequest: async () => input.withWorkRequest
      ? {
          trigger: "shitrat",
          addressedBy: "emoji",
          channelId: "CEXAMPLE",
          channelName: "lc-example-project",
          messageTs: "1785950000.100",
          threadTs: "1785950000.100",
          replyThreadId: "slack:CEXAMPLE:1785950000.100",
          botDeliveryReady: true,
          binding: { cwd: "/tmp/example-project" },
        }
      : undefined,
    acknowledgeWorkRequest: async (request) => {
      acknowledged.push(request.replyThreadId);
    },
    onWorkRequestError: (error, phase) => errors.push(`${phase}:${String(error)}`),
    machineId: "flagg-test",
  });
  return { publisher, event, appended, acknowledged, errors };
}

describe("stream inbound ShitRat work requests", () => {
  test("publishes a non-Joel lc/cc :shitrat: request as addressed work", async () => {
    const tested = harness({ authorizedJoel: false, withWorkRequest: true });
    await tested.publisher.publishEvent(tested.event);

    expect(tested.appended).toHaveLength(1);
    expect(tested.appended[0]?.payload).toMatchObject({
      addressing: "addressed",
      actorId: "UTEAM",
      workRequest: {
        trigger: "shitrat",
        addressedBy: "emoji",
        channelName: "lc-example-project",
        replyThreadId: "slack:CEXAMPLE:1785950000.100",
        botDeliveryReady: true,
        binding: { cwd: "/tmp/example-project" },
      },
    });
    expect(tested.acknowledged).toEqual(["slack:CEXAMPLE:1785950000.100"]);
    expect(tested.errors).toEqual([]);
  });

  test("keeps an untriggered non-Joel Slack message out of the agent stream", async () => {
    const tested = harness({ authorizedJoel: false, withWorkRequest: false });
    await tested.publisher.publishEvent(tested.event);
    expect(tested.appended).toEqual([]);
    expect(tested.acknowledged).toEqual([]);
  });

  test("preserves Joel ambient Slack observation without a trigger", async () => {
    const tested = harness({ authorizedJoel: true, withWorkRequest: false });
    await tested.publisher.publishEvent(tested.event);
    expect(tested.appended[0]?.payload).toMatchObject({ addressing: "ambient" });
  });

  test("records the request even when reaction acknowledgement fails", async () => {
    const appended: AppendMessageEventInput[] = [];
    const errors: string[] = [];
    const publisher = createStreamInboundPublisher({
      eventLog: {
        append: async (value) => {
          appended.push(value);
          return {
            eventId: "inbound-1",
            semanticKey: value.semanticKey,
            deduplicated: false,
            schemaVersion: 1,
          };
        },
      },
      resolveFlowId: async () => undefined,
      resolveWorkRequest: async () => ({
        trigger: "shitrat",
        addressedBy: "emoji",
        channelId: "CEXAMPLE",
        channelName: "lc-example-project",
        messageTs: "1785950000.100",
        threadTs: "1785950000.100",
        replyThreadId: "slack:CEXAMPLE:1785950000.100",
        botDeliveryReady: true,
      }),
      acknowledgeWorkRequest: async () => {
        throw new Error("missing_scope");
      },
      onWorkRequestError: (error, phase) => errors.push(`${phase}:${String(error)}`),
    });

    await publisher.publishEvent(slackEvent(false));
    expect(appended).toHaveLength(1);
    expect(appended[0]?.payload).toMatchObject({
      workRequest: { botDeliveryReady: false },
    });
    expect(errors).toEqual(["acknowledge:Error: missing_scope"]);
  });
});
