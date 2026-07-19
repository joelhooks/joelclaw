import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import {
  MESSAGE_ACTION_REQUESTED,
  MessageActionRequestedEvent,
} from "@joelclaw/message-contract";
import { Schema } from "effect";
import {
  createLearnerFlowActionFunction,
  learnerFlowAction,
} from "./learner-flow-actions";

const FLOW_ID = "flow_v2_11111111-1111-4111-8111-111111111111";
const NOTIFICATION_EVENT_ID = "22222222-2222-4222-8222-222222222222";

function action(
  actionId: "learner-flow.ack" | "learner-flow.run" | "learner-flow.investigate",
) {
  return Schema.decodeUnknownSync(MessageActionRequestedEvent)({
    name: MESSAGE_ACTION_REQUESTED,
    data: {
      contractVersion: 2,
      flowId: FLOW_ID,
      platform: "telegram",
      actor: { id: "7718912466", displayName: "Joel" },
      actionId,
      at: "2026-07-19T15:00:00.000Z",
      rawEventId: `callback-${actionId}`,
      platformMessageId: "14562",
      correlationSource: "gateway-acting",
    },
  }).data;
}

function ok(result: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, result });
}

function commandResponse(args: readonly string[]) {
  if (args[1] === "wake" && args[2] === "in") {
    return {
      exitCode: 0,
      stdout: ok({ schedule: { scheduleId: "schedule-fixture" } }),
      stderr: "",
    };
  }
  if (args[1] === "wake" && args[2] === "list") {
    return {
      exitCode: 0,
      stdout: ok({ schedules: [{ scheduleId: "schedule-fixture" }] }),
      stderr: "",
    };
  }
  if (args[1] === "notify" && args[2] === "send") {
    return {
      exitCode: 0,
      stdout: ok({ eventId: NOTIFICATION_EVENT_ID }),
      stderr: "",
    };
  }
  if (args[1] === "notify" && args[2] === "wait") {
    return {
      exitCode: 0,
      stdout: ok({
        deliveryState: "confirmed",
        platformMessageId: "7718912466:14563",
      }),
      stderr: "",
    };
  }
  throw new Error(`Unexpected command: ${args.join(" ")}`);
}

async function fixture(correlationId = "campaign-pulse:event-1") {
  const directory = await mkdtemp(join(tmpdir(), "learner-flow-action-test-"));
  const logPath = join(directory, "pulse-log.jsonl");
  await writeFile(logPath, "");
  const commandCalls: string[][] = [];
  const telemetry: Record<string, unknown>[] = [];
  const fn = createLearnerFlowActionFunction({
    cwd: directory,
    logPath,
    now: () => new Date("2026-07-19T15:01:00.000Z"),
    nextEventId: () => NOTIFICATION_EVENT_ID,
    resolveDeclaration: async () => ({
      correlationId,
      actionIds: [
        "learner-flow.ack",
        "learner-flow.run",
        "learner-flow.investigate",
      ],
    }),
    emit: async (event) => {
      telemetry.push(event as Record<string, unknown>);
    },
    runCommand: async (args) => {
      commandCalls.push([...args]);
      return commandResponse(args);
    },
  });
  return { commandCalls, directory, fn, logPath, telemetry };
}

describe("Learner Flow actions", () => {
  test("registers as the callback-native durable consumer", () => {
    const options = (
      learnerFlowAction as unknown as {
        opts?: { id?: string; idempotency?: string };
      }
    ).opts;
    expect(options?.id).toBe("learner-flow/action");
    expect(options?.idempotency).toBe("event.data.rawEventId");
  });

  test("acknowledges a Campaign Pulse flow without emoji vocabulary", async () => {
    const setup = await fixture();
    const execution = await new InngestTestEngine({
      function: setup.fn,
      events: [{ name: MESSAGE_ACTION_REQUESTED, data: action("learner-flow.ack") }],
    }).execute();

    expect(execution.result).toEqual({ status: "acknowledged", flowId: FLOW_ID });
    expect(JSON.parse((await readFile(setup.logPath, "utf8")).trim())).toMatchObject({
      kind: "ack",
      source: MESSAGE_ACTION_REQUESTED,
      flowId: FLOW_ID,
      actionId: "learner-flow.ack",
      handledAt: "2026-07-19T15:01:00.000Z",
    });
    expect(setup.commandCalls).toEqual([
      [
        "joelclaw",
        "notify",
        "send",
        "--kind",
        "alert",
        "--priority",
        "high",
        "--source",
        "learner-flow-action",
        "--event-id",
        NOTIFICATION_EVENT_ID,
        "Seen. Next pulse stays scheduled.",
      ],
      [
        "joelclaw",
        "notify",
        "wait",
        "22222222-2222-4222-8222-222222222222",
        "--source",
        "learner-flow-action",
        "--timeout",
        "15s",
      ],
    ]);
  });

  test("does not append a Campaign Pulse ack for a Daily Flow message", async () => {
    const setup = await fixture("daily-flow-agent:event-1");
    const execution = await new InngestTestEngine({
      function: setup.fn,
      events: [{ name: MESSAGE_ACTION_REQUESTED, data: action("learner-flow.ack") }],
    }).execute();

    expect(execution.result).toMatchObject({ status: "acknowledged" });
    expect(await readFile(setup.logPath, "utf8")).toBe("");
  });

  test("reads back the Daily Flow schedule before confirming success", async () => {
    const setup = await fixture();
    const execution = await new InngestTestEngine({
      function: setup.fn,
      events: [{ name: MESSAGE_ACTION_REQUESTED, data: action("learner-flow.run") }],
    }).execute();

    expect(execution.result).toMatchObject({
      status: "scheduled",
      kind: "flow-agent",
      scheduleId: "schedule-fixture",
      flowId: FLOW_ID,
    });
    expect(setup.commandCalls.map((args) => args.slice(1, 3))).toEqual([
      ["wake", "in"],
      ["wake", "list"],
      ["notify", "send"],
      ["notify", "wait"],
    ]);
    expect(setup.commandCalls[0]?.join(" ")).toContain(
      ".brain/projects/learner-flow-ops/asset-daily-flow-agent-runbook.svx",
    );
  });

  test("does not send success when wake-list readback misses the schedule", async () => {
    const setup = await fixture();
    const commandCalls: string[][] = [];
    const fn = createLearnerFlowActionFunction({
      cwd: setup.directory,
      logPath: setup.logPath,
      resolveDeclaration: async () => ({
        correlationId: "campaign-pulse:event-1",
        actionIds: ["learner-flow.run"],
      }),
      emit: async () => {},
      runCommand: async (args) => {
        commandCalls.push([...args]);
        if (args[1] === "wake" && args[2] === "list") {
          return { exitCode: 0, stdout: ok({ schedules: [] }), stderr: "" };
        }
        return commandResponse(args);
      },
    });
    const execution = await new InngestTestEngine({
      function: fn,
      events: [{ name: MESSAGE_ACTION_REQUESTED, data: action("learner-flow.run") }],
    }).execute();

    expect(execution.error).toBeDefined();
    expect(String((execution.error as { message?: string })?.message ?? execution.error)).toContain(
      "did not confirm schedule",
    );
    expect(commandCalls.map((args) => args.slice(1, 3))).toEqual([
      ["wake", "in"],
      ["wake", "list"],
    ]);
  });

  test("reads back the investigator schedule before confirming success", async () => {
    const setup = await fixture();
    const execution = await new InngestTestEngine({
      function: setup.fn,
      events: [{ name: MESSAGE_ACTION_REQUESTED, data: action("learner-flow.investigate") }],
    }).execute();

    expect(execution.result).toMatchObject({
      status: "scheduled",
      kind: "investigate",
      scheduleId: "schedule-fixture",
      flowId: FLOW_ID,
    });
    expect(setup.commandCalls[0]?.join(" ")).toContain(
      ".brain/projects/campaign-pulse/asset-pulse-investigator-runbook.svx",
    );
  });
});
