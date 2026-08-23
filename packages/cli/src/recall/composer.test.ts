/**
 * Composer tests: two ports, three lanes, no lane answering for another.
 */

import { describe, expect, test } from "bun:test";
import { composeRecall } from "./composer";
import { curatedSearchResult, flowingSuccessEnvelope, TEST_FLOWING_CONFIG, TEST_SECRET, testRequest } from "./test-fixtures";

const lease = async () => ({ ok: true as const, value: TEST_SECRET });

function flowingRunner(stdout: string, exitCode = 0) {
  return async () => ({
    exitCode,
    stdout,
    stderr: "",
    timedOut: false,
    missingExecutable: false,
  });
}

const bothLanesAnswer = () =>
  composeRecall({
    request: testRequest(),
    flowingConfig: TEST_FLOWING_CONFIG,
    runProcess: flowingRunner(JSON.stringify(flowingSuccessEnvelope())),
    leaseCredential: lease,
    curatedSearch: () => curatedSearchResult([{ id: "brain-1" }, { id: "brain-2" }]),
    parentEnv: { PATH: "/usr/bin" },
  });

describe("composeRecall", () => {
  test("returns exactly the three canonical lanes", async () => {
    const outcome = await bothLanesAnswer();
    expect(Object.keys(outcome.result.lanes).sort()).toEqual([
      "curatedPages",
      "flowingObservations",
      "flowingReflections",
    ]);
  });

  test("keeps each lane's own ranking and never merges them", async () => {
    const outcome = await bothLanesAnswer();
    const { flowingReflections, curatedPages } = outcome.result.lanes;
    if (
      flowingReflections._tag !== "RecallLaneAvailableV1" ||
      curatedPages._tag !== "RecallLaneAvailableV1"
    ) {
      throw new Error("expected both lanes to answer");
    }

    expect(flowingReflections.items.map((item) => item.rank)).toEqual([1, 2]);
    expect(curatedPages.items.map((item) => item.rank)).toEqual([1, 2]);
    expect(flowingReflections.scoreScale).toBe("unit-interval");
    expect(curatedPages.scoreScale).toBe("bm25-negated");
    for (const item of flowingReflections.items) expect(item.lane).toBe("flowing-reflections");
    for (const item of curatedPages.items) expect(item.lane).toBe("curated-pages");
  });

  test("a flowing failure leaves the curated lane intact and typed", async () => {
    const outcome = await composeRecall({
      request: testRequest(),
      flowingConfig: TEST_FLOWING_CONFIG,
      runProcess: flowingRunner("not json", 0),
      leaseCredential: lease,
      curatedSearch: () => curatedSearchResult([{ id: "brain-1" }]),
      parentEnv: {},
    });

    expect(outcome.result.lanes.curatedPages._tag).toBe("RecallLaneAvailableV1");
    expect(outcome.result.lanes.flowingReflections._tag).toBe("RecallLaneUnavailableV1");
    expect(outcome.result.unavailable.map((entry) => entry.lane).sort()).toEqual([
      "flowing-observations",
      "flowing-reflections",
    ]);
  });

  test("a curated failure leaves the flowing lanes intact and typed", async () => {
    const outcome = await composeRecall({
      request: testRequest(),
      flowingConfig: TEST_FLOWING_CONFIG,
      runProcess: flowingRunner(JSON.stringify(flowingSuccessEnvelope())),
      leaseCredential: lease,
      curatedSearch: () => {
        throw new Error("critical.db not found: /Users/joel/.joelclaw/critical.db");
      },
      parentEnv: {},
    });

    expect(outcome.result.lanes.flowingReflections._tag).toBe("RecallLaneAvailableV1");
    expect(outcome.result.unavailable.map((entry) => entry.lane)).toEqual(["curated-pages"]);
    expect(JSON.stringify(outcome.result)).not.toContain("/Users/joel");
  });

  test("an unconfigured flowing port reports not-configured rather than guessing", async () => {
    const outcome = await composeRecall({
      request: testRequest(),
      curatedSearch: () => curatedSearchResult([]),
      parentEnv: {},
    });

    const lane = outcome.result.lanes.flowingReflections;
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("not-configured");
  });

  test("an executable outside the trusted release root is refused before anything spawns", async () => {
    let spawned = false;
    const outcome = await composeRecall({
      request: testRequest(),
      flowingSettings: {
        read_executable: "/usr/bin/env",
        credential_secret_name: "flowing-runtime-url",
      },
      trustedReleaseRoot: "/nonexistent-trusted-root-for-tests",
      runProcess: async () => {
        spawned = true;
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, missingExecutable: false };
      },
      leaseCredential: lease,
      curatedSearch: () => curatedSearchResult([]),
      parentEnv: {},
    });

    expect(spawned).toBe(false);
    const lane = outcome.result.lanes.flowingObservations;
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(["not-configured", "untrusted-executable"]).toContain(lane.code);
  });

  test("the resolved scope and access mirror the request exactly", async () => {
    const request = testRequest();
    const outcome = await bothLanesAnswer();
    expect(outcome.result.resolvedScope).toEqual(request.scope);
    expect(outcome.result.resolvedAccess).toEqual(request.access);
  });
});
