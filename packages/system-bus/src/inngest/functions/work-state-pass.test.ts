import { describe, expect, test } from "bun:test";
import {
  __workStatePassTestUtils,
  classifyChannelRoots,
  isNonJoelHumanRoot,
  renderObservationPage,
  resolveWorkStatePassConfig,
  seededScenarioScan,
  selectNewFindings,
  type WorkStateFinding,
  type WorkStatePassConfig,
  workStateForRoot,
} from "./work-state-pass";

const NOW = Date.parse("2026-07-17T16:00:00.000Z");
const CHANNEL = { id: "C0211NSK3TP", name: "cc-matt-p" };

function tsHoursAgo(hours: number): string {
  return String((NOW - hours * 3_600_000) / 1000);
}

function config(overrides: Partial<WorkStatePassConfig> = {}): WorkStatePassConfig {
  return {
    enabled: true,
    channels: [CHANNEL],
    untaggedAfterHours: 4,
    startedStaleAfterDays: 7,
    historyLimit: 200,
    observationsDir: "/tmp/observations",
    notifiedStatePath: "/tmp/work-state-pass.json",
    lastRunPath: "/tmp/work-state-pass-last-run.json",
    wakeMode: "notify",
    seededProofEnabled: true,
    ...overrides,
  };
}

function finding(key = "C0211NSK3TP:1:untagged:untagged"): WorkStateFinding {
  return {
    key,
    kind: "untagged",
    channelId: CHANNEL.id,
    channelName: CHANNEL.name,
    rootTs: "1.000001",
    authorId: "UOTHER",
    authorLabel: "Matt",
    workState: "untagged",
    ageHours: 5,
    thresholdHours: 4,
    permalink: "https://eggheadio.slack.com/archives/C0211NSK3TP/p1000001",
    provenance: "slack.conversations.history",
  };
}

describe("Slack root work-state", () => {
  test("uses only Joel-owned reactions and shipped wins", () => {
    expect(
      workStateForRoot({
        reactions: [
          { name: "shitrat", users: [__workStatePassTestUtils.JOEL_SLACK_USER_ID] },
          { name: "white_check_mark", users: [__workStatePassTestUtils.JOEL_SLACK_USER_ID] },
        ],
      }),
    ).toBe("shipped");

    expect(
      workStateForRoot({
        reactions: [
          { name: "shitrat", users: ["USOMEONEELSE"] },
          { name: "white_check_mark", users: ["USOMEONEELSE"] },
        ],
      }),
    ).toBe("untagged");
  });

  test("excludes Joel, bots, apps, and replies", () => {
    expect(isNonJoelHumanRoot({ ts: "1.0", user: "UOTHER" })).toBe(true);
    expect(
      isNonJoelHumanRoot({ ts: "1.0", user: __workStatePassTestUtils.JOEL_SLACK_USER_ID }),
    ).toBe(false);
    expect(isNonJoelHumanRoot({ ts: "1.0", user: "UOTHER", bot_id: "B1" })).toBe(false);
    expect(isNonJoelHumanRoot({ ts: "1.0", user: "UOTHER", app_id: "A1" })).toBe(false);
    expect(isNonJoelHumanRoot({ ts: "1.0", user: "UOTHER", subtype: "channel_join" })).toBe(false);
    expect(isNonJoelHumanRoot({ ts: "1.0", user: "UOTHER", subtype: "file_share" })).toBe(true);
    expect(
      isNonJoelHumanRoot({ ts: "2.0", thread_ts: "1.0", user: "UOTHER" }),
    ).toBe(false);
  });
});

describe("work-state thresholds", () => {
  test("uses strict greater-than boundaries", () => {
    const scan = classifyChannelRoots({
      channel: CHANNEL,
      nowMs: NOW,
      untaggedAfterHours: 4,
      startedStaleAfterDays: 7,
      roots: [
        { ts: tsHoursAgo(4), user: "UEXACTUNTAGGED" },
        { ts: tsHoursAgo(4.01), user: "UOVERUNTAGGED" },
        {
          ts: tsHoursAgo(7 * 24),
          user: "UEXACTSTARTED",
          reactions: [{ name: "shitrat", users: [__workStatePassTestUtils.JOEL_SLACK_USER_ID] }],
        },
        {
          ts: tsHoursAgo(7 * 24 + 0.01),
          user: "UOVERSTARTED",
          reactions: [{ name: "shitrat", users: [__workStatePassTestUtils.JOEL_SLACK_USER_ID] }],
        },
      ],
    });

    expect(scan.requestRootsSeen).toBe(4);
    expect(scan.findings.map((item) => item.authorId)).toEqual([
      "UOVERUNTAGGED",
      "UOVERSTARTED",
    ]);
    expect(scan.findings.map((item) => item.kind)).toEqual(["untagged", "stale_started"]);
  });

  test("seeded scenario produces one untagged and one stale-started finding", () => {
    const scan = seededScenarioScan(config(), NOW);
    expect(scan.rootsSeen).toBe(2);
    expect(scan.findings).toHaveLength(2);
    expect(scan.findings.map((item) => item.kind).sort()).toEqual([
      "stale_started",
      "untagged",
    ]);
    expect(scan.findings.every((item) => item.provenance === "seeded-proof")).toBe(true);
  });
});

describe("notification hygiene", () => {
  test("builds a stable UUID v4 idempotency key from the transition set", () => {
    const first = finding();
    const second = finding("C09LKT871PE:2:stale_started:started");
    const eventId = __workStatePassTestUtils.deliveryEventId([first, second]);
    expect(eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(__workStatePassTestUtils.deliveryEventId([second, first])).toBe(eventId);
    expect(__workStatePassTestUtils.deliveryEventId([first])).not.toBe(eventId);
  });

  test("only selects state/threshold keys not already notified", () => {
    const first = finding();
    const changed = { ...finding("C0211NSK3TP:1:stale_started:started"), kind: "stale_started" as const, workState: "started" as const };
    const state = {
      version: 1 as const,
      updatedAt: "2026-07-17T15:00:00.000Z",
      runId: "prior",
      notified: {
        [first.key]: {
          notifiedAt: "2026-07-17T15:00:00.000Z",
          kind: first.kind,
          workState: first.workState,
          status: "notified" as const,
          runId: "prior",
        },
      },
    };
    expect(selectNewFindings([first, changed], state)).toEqual([changed]);
  });

  test("a durable reservation suppresses a crash retry before delivery completion", () => {
    const first = finding();
    const reserved = __workStatePassTestUtils.nextNotifiedState({
      previous: {
        version: 1,
        updatedAt: new Date(0).toISOString(),
        runId: "none",
        notified: {},
      },
      currentFindings: [first],
      newEntries: [first],
      newStatus: "reserved",
      runId: "run-1",
      nowIso: "2026-07-17T15:00:00.000Z",
    });
    expect(reserved.notified[first.key]?.status).toBe("reserved");
    expect(
      selectNewFindings([first], reserved, Date.parse("2026-07-17T15:05:00.000Z")),
    ).toEqual([]);
    expect(
      selectNewFindings(
        [first],
        reserved,
        Date.parse("2026-07-17T15:15:00.000Z"),
      ),
    ).toEqual([first]);
  });

  test("reconciles a queued reservation before a changed batch is rebuilt", async () => {
    const first = finding();
    const disappeared = finding("C09LKT871PE:2:stale_started:started");
    const arrived = finding("C0211NSK3TP:3:untagged:untagged");
    const deliveryEventId = __workStatePassTestUtils.deliveryEventId([first, disappeared]);
    const reserved = __workStatePassTestUtils.nextNotifiedState({
      previous: {
        version: 1,
        updatedAt: new Date(0).toISOString(),
        runId: "none",
        notified: {},
      },
      currentFindings: [first, disappeared],
      newEntries: [first, disappeared],
      newStatus: "reserved",
      newDeliveryEventId: deliveryEventId,
      runId: "run-1",
      nowIso: "2026-07-17T15:00:00.000Z",
    });
    const reconciled = await __workStatePassTestUtils.reconcileDeliveredReservations(
      reserved,
      Date.parse("2026-07-17T15:15:00.000Z"),
      async (eventId) => eventId === deliveryEventId,
    );
    expect(reconciled.reconciled).toBe(2);
    expect(reconciled.state.notified[first.key]?.status).toBe("notified");
    expect(
      selectNewFindings(
        [first, arrived],
        reconciled.state,
        Date.parse("2026-07-17T15:15:00.000Z"),
      ),
    ).toEqual([arrived]);
  });
});

describe("Slack transport", () => {
  test("honors Retry-After with an Inngest retry error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "retry-after": "17" },
      })) as unknown as typeof fetch;
    try {
      await expect(
        __workStatePassTestUtils.slackGet("conversations.history", "not-a-real-token", {
          channel: CHANNEL.id,
        }),
      ).rejects.toThrow("rate limited for 17s");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("observation page", () => {
  test("is sensitive, provenance-carrying, and contains no Slack message body", () => {
    const scan = seededScenarioScan(config(), NOW);
    const page = renderObservationPage({
      runId: "seeded-run",
      startedAt: "2026-07-17T16:00:00.000Z",
      completedAt: "2026-07-17T16:00:01.000Z",
      scans: [scan],
      findings: scan.findings,
      config: config(),
      seededScenario: true,
    });

    expect(page).toContain("privacy: sensitive");
    expect(page).toContain("sourceKind: slack-work-state-pass");
    expect(page.includes("slack.conversations.history")).toBe(false);
    expect(page).toContain("seeded-proof");
    expect(page).toContain("## Observations");
    expect(page).toContain("## Decisions");
    expect(page).toContain("message bodies");
    expect(__workStatePassTestUtils.secretScan(page)).toEqual([]);
  });
});

describe("configuration", () => {
  test("defaults launch channels and keeps pass disabled until runtime enable", () => {
    const resolved = resolveWorkStatePassConfig({ HOME: "/tmp" });
    expect(resolved.enabled).toBe(false);
    expect(resolved.channels).toEqual([
      { id: "C0211NSK3TP", name: "cc-matt-p" },
      { id: "C09LKT871PE", name: "brain-joel" },
    ]);
    expect(resolved.untaggedAfterHours).toBe(4);
    expect(resolved.startedStaleAfterDays).toBe(7);
  });

  test("accepts all launch settings from environment", () => {
    const resolved = resolveWorkStatePassConfig({
      WORK_STATE_PASS_ENABLED: "1",
      WORK_STATE_PASS_CHANNELS: "C0211NSK3TP:cc-matt-p,C09LKT871PE:brain-joel",
      WORK_STATE_PASS_UNTAGGED_AFTER_HOURS: "6",
      WORK_STATE_PASS_STARTED_STALE_AFTER_DAYS: "9",
      WORK_STATE_PASS_HISTORY_LIMIT: "50",
      WORK_STATE_PASS_WAKE_MODE: "off",
      WORK_STATE_PASS_SEEDED_PROOF_ENABLED: "true",
    });
    expect(resolved).toMatchObject({
      enabled: true,
      untaggedAfterHours: 6,
      startedStaleAfterDays: 9,
      historyLimit: 50,
      wakeMode: "off",
      seededProofEnabled: true,
    });
  });
});
