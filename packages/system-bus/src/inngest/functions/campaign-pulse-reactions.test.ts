import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import {
  MESSAGE_REACTION_RECEIVED,
  MessageReactionReceivedEvent,
} from "@joelclaw/message-contract";
import { Schema } from "effect";
import {
  campaignPulseReaction,
  createCampaignPulseReactionFunction,
} from "./campaign-pulse-reactions";

const FLOW_ID = "notify:7c1924bc-b192-42da-b145-64dedfa2fe94";

function reaction(emoji: string, flowId = FLOW_ID) {
  return Schema.decodeUnknownSync(MessageReactionReceivedEvent)({
    name: MESSAGE_REACTION_RECEIVED,
    data: {
      contractVersion: 2,
      flowId,
      platform: "telegram",
      actor: { id: "7718912466", displayName: "Joel" },
      emoji,
      action: "added",
      added: true,
      at: "2026-07-17T15:00:00.000Z",
      rawEventId: `reaction-${emoji.codePointAt(0)}`,
      platformMessageId: "14562",
      correlationSource: "redis-legacy-telegram",
    },
  }).data;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "campaign-pulse-reaction-test-"));
  const statePath = join(directory, "state.json");
  const logPath = join(directory, "pulse-log.jsonl");
  await writeFile(
    statePath,
    JSON.stringify({
      schema: "campaign-pulse.snapshot.v1",
      runId: "pulse-run-fixture",
      dmFlows: [
        {
          flowId: FLOW_ID,
          sentAt: "2026-07-17T14:59:00.000Z",
          kind: "campaign-pulse",
          runId: "pulse-run-fixture",
        },
      ],
      lastDmFlowId: FLOW_ID,
    }),
  );
  await writeFile(logPath, "");
  return { directory, statePath, logPath };
}

describe("Campaign Pulse reactions", () => {
  test("registers as a durable reaction consumer", () => {
    const options = (
      campaignPulseReaction as unknown as {
        opts?: { id?: string; idempotency?: string };
      }
    ).opts;
    expect(options?.id).toBe("campaign-pulse/reaction");
    expect(options?.idempotency).toBe("event.data.rawEventId");
  });

  test("executes a synthetic thumbs-up event, appends the ack, and queues the exact receipt", async () => {
    const paths = await fixture();
    const commandCalls: string[][] = [];
    const telemetry: Record<string, unknown>[] = [];
    const fn = createCampaignPulseReactionFunction({
      statePath: paths.statePath,
      logPath: paths.logPath,
      cwd: paths.directory,
      now: () => new Date("2026-07-17T15:01:00.000Z"),
      emit: async (event) => {
        telemetry.push(event as Record<string, unknown>);
      },
      runCommand: async (args) => {
        commandCalls.push([...args]);
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      },
    });

    const execution = await new InngestTestEngine({
      function: fn,
      events: [{ name: MESSAGE_REACTION_RECEIVED, data: reaction("👍") }],
    }).execute();

    expect(execution.result).toEqual({ status: "acknowledged", flowId: FLOW_ID });
    expect(JSON.parse((await readFile(paths.logPath, "utf8")).trim())).toMatchObject({
      kind: "ack",
      flowId: FLOW_ID,
      emoji: "👍",
      handledAt: "2026-07-17T15:01:00.000Z",
    });
    expect(commandCalls).toEqual([
      [
        "joelclaw",
        "notify",
        "send",
        "--priority",
        "high",
        "--source",
        "campaign-pulse-reaction",
        "Seen. Next pulse stays scheduled.",
      ],
    ]);
    expect(telemetry.some((event) => event.action === "campaign_pulse.reaction.acknowledged")).toBe(
      true,
    );
  });

  test("executes a synthetic wrench event with the daily-flow wake shape", async () => {
    const paths = await fixture();
    const commandCalls: string[][] = [];
    const fn = createCampaignPulseReactionFunction({
      statePath: paths.statePath,
      logPath: paths.logPath,
      cwd: paths.directory,
      emit: async () => {},
      runCommand: async (args) => {
        commandCalls.push([...args]);
        if (args[1] === "wake") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              result: { schedule: { scheduleId: "sched-flow-fixture" } },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      },
    });

    const execution = await new InngestTestEngine({
      function: fn,
      events: [{ name: MESSAGE_REACTION_RECEIVED, data: reaction("🔧") }],
    }).execute();

    expect(execution.result).toMatchObject({
      status: "scheduled",
      kind: "flow-agent",
      scheduleId: "sched-flow-fixture",
      flowId: FLOW_ID,
    });
    expect(commandCalls[0]?.slice(0, 7)).toEqual([
      "joelclaw",
      "wake",
      "in",
      "1m",
      "--verb",
      "spawn",
      "--brief",
    ]);
    expect(commandCalls[0]?.join(" ")).toContain(
      ".brain/projects/learner-flow-ops/asset-daily-flow-agent-runbook.svx",
    );
    expect(commandCalls[1]?.at(-1)).toBe("Flow agent spawning.");
  });

  test("executes a synthetic magnifier event with the investigator wake shape", async () => {
    const paths = await fixture();
    const commandCalls: string[][] = [];
    const fn = createCampaignPulseReactionFunction({
      statePath: paths.statePath,
      logPath: paths.logPath,
      cwd: paths.directory,
      emit: async () => {},
      runCommand: async (args) => {
        commandCalls.push([...args]);
        if (args[1] === "wake") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              result: { schedule: { scheduleId: "sched-investigator-fixture" } },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      },
    });

    const execution = await new InngestTestEngine({
      function: fn,
      events: [{ name: MESSAGE_REACTION_RECEIVED, data: reaction("🔎") }],
    }).execute();

    expect(execution.result).toMatchObject({
      status: "scheduled",
      kind: "investigate",
      scheduleId: "sched-investigator-fixture",
      flowId: FLOW_ID,
    });
    expect(commandCalls[0]?.join(" ")).toContain(
      ".brain/projects/campaign-pulse/asset-pulse-investigator-runbook.svx",
    );
    expect(commandCalls[1]?.at(-1)).toBe("Investigator spawning, it will DM findings.");
  });

  test("ignores a supported emoji when the flow is not a persisted Pulse DM", async () => {
    const paths = await fixture();
    let commandCalls = 0;
    const fn = createCampaignPulseReactionFunction({
      statePath: paths.statePath,
      logPath: paths.logPath,
      cwd: paths.directory,
      emit: async () => {},
      runCommand: async () => {
        commandCalls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      },
    });

    const execution = await new InngestTestEngine({
      function: fn,
      events: [
        {
          name: MESSAGE_REACTION_RECEIVED,
          data: reaction("🔎", "notify:11111111-1111-4111-8111-111111111111"),
        },
      ],
    }).execute();

    expect(execution.result).toEqual({
      status: "ignored",
      reason: "flow-not-campaign-pulse",
      flowId: "notify:11111111-1111-4111-8111-111111111111",
    });
    expect(commandCalls).toBe(0);
  });
});
