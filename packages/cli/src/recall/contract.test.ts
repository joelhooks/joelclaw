import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ComposedRecallRequestV1Schema,
  ComposedRecallResultV1Schema,
  collectUnavailable,
  decodeComposedRecallResult,
  encodeComposedRecallResult,
  LANE_FIELDS,
  LANE_SCORE_SCALE,
  RECALL_LANES,
  unavailableLane,
} from "./contract";
import { testRequest } from "./test-fixtures";

const decodeRequest = Schema.decodeUnknownEither(ComposedRecallRequestV1Schema);
const decodeResult = Schema.decodeUnknownEither(ComposedRecallResultV1Schema);

const request = testRequest();
const hexDigest = "a".repeat(64);

function laneItem(lane: (typeof RECALL_LANES)[number], rank: number, id: string, score: number) {
  return {
    evidenceIds: [`evidence:${id}`],
    id,
    kind: "reflection",
    lane,
    privacy: "private" as string,
    rank,
    scope: {
      _tag: "ProjectWorkstream" as const,
      project: request.scope.project,
      workstream: request.scope.workstream,
    },
    scopeBinding: "record-scope" as string,
    score,
    title: `item ${id}`,
  };
}

function availableLane(lane: (typeof RECALL_LANES)[number], items: ReturnType<typeof laneItem>[]) {
  return {
    _tag: "RecallLaneAvailableV1" as const,
    health: { _tag: "Healthy" as const },
    items,
    lane,
    scoreScale: LANE_SCORE_SCALE[lane] as string,
    source: "test",
  };
}

function baseResult() {
  const lanes = {
    curatedPages: availableLane("curated-pages", []),
    flowingObservations: availableLane("flowing-observations", []),
    flowingReflections: availableLane("flowing-reflections", [
      laneItem("flowing-reflections", 1, "r1", 0.9),
      laneItem("flowing-reflections", 2, "r2", 0.7),
    ]),
  };
  return {
    _tag: "ComposedRecallResultV1" as const,
    lanes,
    request,
    resolvedAccess: request.access,
    resolvedScope: request.scope,
    schemaVersion: 1 as const,
    unavailable: [],
  };
}

describe("composed recall request", () => {
  test("accepts an exact scope with an explicit access decision", () => {
    expect(decodeRequest(request)._tag).toBe("Right");
  });

  test("rejects a missing project scope", () => {
    const result = decodeRequest({ ...request, scope: { ...request.scope, project: "" } });
    expect(result._tag).toBe("Left");
  });

  test("rejects an empty privacy grant", () => {
    const result = decodeRequest({
      ...request,
      access: { ...request.access, allowedPrivacy: [] },
    });
    expect(result._tag).toBe("Left");
  });

  test("rejects a missing principal or purpose", () => {
    expect(
      decodeRequest({ ...request, access: { ...request.access, principalRef: "  " } })._tag,
    ).toBe("Left");
    expect(decodeRequest({ ...request, access: { ...request.access, purpose: "" } })._tag).toBe(
      "Left",
    );
  });

  test("rejects a non-instant decided-at", () => {
    const result = decodeRequest({
      ...request,
      access: { ...request.access, decidedAt: "yesterday" },
    });
    expect(result._tag).toBe("Left");
  });

  test("carries no budget, category, hold, or discard vocabulary", () => {
    const fields = Object.keys(request as unknown as Record<string, unknown>);
    for (const retired of ["budget", "category", "includeHold", "includeDiscard", "minScore"]) {
      expect(fields).not.toContain(retired);
    }
  });
});

describe("composed recall result", () => {
  test("round-trips through encode and decode without loss", () => {
    const decoded = decodeComposedRecallResult(baseResult());
    const encoded = encodeComposedRecallResult(decoded);
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(JSON.parse(JSON.stringify(baseResult())));
    expect(decodeComposedRecallResult(JSON.parse(JSON.stringify(encoded)))).toEqual(decoded);
  });

  test("keeps every lane in its own named field", () => {
    const decoded = decodeComposedRecallResult(baseResult());
    for (const [field, lane] of LANE_FIELDS) {
      expect(decoded.lanes[field].lane).toBe(lane);
    }
    expect(Object.keys(decoded.lanes).sort()).toEqual([
      "curatedPages",
      "flowingObservations",
      "flowingReflections",
    ]);
  });

  test("refuses an item that was moved into another lane", () => {
    const candidate = baseResult();
    const crossRanked = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        curatedPages: availableLane("curated-pages", [
          laneItem("flowing-reflections", 1, "r1", 0.9),
        ]),
      },
    };
    expect(decodeResult(crossRanked)._tag).toBe("Left");
  });

  test("refuses a lane whose ranks are not a 1-based sequence", () => {
    const candidate = baseResult();
    const misordered = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        flowingReflections: availableLane("flowing-reflections", [
          laneItem("flowing-reflections", 2, "r1", 0.9),
          laneItem("flowing-reflections", 3, "r2", 0.7),
        ]),
      },
    };
    expect(decodeResult(misordered)._tag).toBe("Left");
  });

  test("refuses a record-scoped item from another scope", () => {
    const candidate = baseResult();
    const widened = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        flowingReflections: availableLane("flowing-reflections", [
          {
            ...laneItem("flowing-reflections", 1, "r1", 0.9),
            scope: {
              _tag: "ProjectWorkstream" as const,
              project: "other.repo",
              workstream: "main",
            },
          },
        ]),
      },
    };
    expect(decodeResult(widened)._tag).toBe("Left");
  });

  test("allows a retrieval-scoped curated item that declares no record scope", () => {
    const candidate = baseResult();
    const curated = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        curatedPages: {
          ...availableLane("curated-pages", [
            {
              ...laneItem("curated-pages", 1, "brain-1", 3.2),
              kind: "brain_pages",
              scopeBinding: "retrieval-scope",
            },
          ]),
          scoreScale: "bm25-negated" as const,
        },
      },
    };
    expect(decodeResult(curated)._tag).toBe("Right");
  });

  test("refuses an item outside the granted privacy tiers", () => {
    const candidate = baseResult();
    const leaked = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        flowingReflections: availableLane("flowing-reflections", [
          { ...laneItem("flowing-reflections", 1, "r1", 0.9), privacy: "sensitive" },
        ]),
      },
    };
    expect(decodeResult(leaked)._tag).toBe("Left");
  });

  test("mirrors every unavailable lane exactly once", () => {
    const candidate = baseResult();
    const withUnavailable = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        flowingObservations: unavailableLane(
          "flowing-observations",
          "test",
          "store-unavailable",
          "down",
        ),
      },
    };
    expect(decodeResult(withUnavailable)._tag).toBe("Left");

    const mirrored = {
      ...withUnavailable,
      unavailable: collectUnavailable(withUnavailable.lanes as never),
    };
    const decoded = decodeResult(mirrored);
    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      expect(decoded.right.unavailable.map((entry) => entry.lane)).toEqual([
        "flowing-observations",
      ]);
    }
  });

  test("a duplicated lane that hides an omitted lane is refused", () => {
    // Two lanes are down. The summary names one of them twice. The totals still
    // match, every entry still points at a real unavailable lane, and one lane
    // that could not answer has vanished from the summary.
    const candidate = baseResult();
    const twoDown = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        flowingObservations: unavailableLane(
          "flowing-observations",
          "test",
          "store-unavailable",
          "down",
        ),
        flowingReflections: unavailableLane("flowing-reflections", "test", "timeout", "slow"),
      },
    };

    const honest = { ...twoDown, unavailable: collectUnavailable(twoDown.lanes as never) };
    expect(decodeResult(honest)._tag).toBe("Right");
    expect(honest.unavailable).toHaveLength(2);

    const duplicated = {
      ...twoDown,
      unavailable: [
        { _tag: "RecallLaneUnavailableV1", code: "store-unavailable", lane: "flowing-observations", message: "down", source: "test" },
        { _tag: "RecallLaneUnavailableV1", code: "store-unavailable", lane: "flowing-observations", message: "down", source: "test" },
      ],
    };
    expect(duplicated.unavailable).toHaveLength(honest.unavailable.length);
    expect(decodeResult(duplicated)._tag).toBe("Left");
  });

  test("an omitted unavailable lane is refused even when every listed entry is true", () => {
    const candidate = baseResult();
    const twoDown = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        flowingObservations: unavailableLane(
          "flowing-observations",
          "test",
          "store-unavailable",
          "down",
        ),
        flowingReflections: unavailableLane("flowing-reflections", "test", "timeout", "slow"),
      },
    };
    const omitted = {
      ...twoDown,
      unavailable: collectUnavailable(twoDown.lanes as never).slice(0, 1),
    };
    expect(decodeResult(omitted)._tag).toBe("Left");
  });

  test("a summary entry for a lane that answered is refused", () => {
    const candidate = baseResult();
    const invented = {
      ...candidate,
      unavailable: [
        { _tag: "RecallLaneUnavailableV1", code: "timeout", lane: "curated-pages", message: "no", source: "test" },
      ],
    };
    expect(decodeResult(invented)._tag).toBe("Left");
  });

  test("lane score scales are declared so two lanes are never comparable", () => {
    const decoded = decodeComposedRecallResult(baseResult());
    const flowing = decoded.lanes.flowingReflections;
    const curated = decoded.lanes.curatedPages;
    expect(flowing._tag).toBe("RecallLaneAvailableV1");
    expect(curated._tag).toBe("RecallLaneAvailableV1");
    if (flowing._tag === "RecallLaneAvailableV1" && curated._tag === "RecallLaneAvailableV1") {
      expect(flowing.scoreScale).toBeDefined();
      expect(curated.scoreScale).toBeDefined();
    }
  });
});

describe("the canonical composed surface", () => {
  test("has exactly three lanes and no migration vocabulary", () => {
    expect([...RECALL_LANES]).toEqual([
      "flowing-reflections",
      "flowing-observations",
      "curated-pages",
    ]);
    expect(RECALL_LANES.join(" ")).not.toContain("legacy");
    expect(LANE_FIELDS.map(([field]) => field).join(" ")).not.toContain("egacy");
  });

  test("the request carries no legacy limit", () => {
    expect(Object.keys(request.limits).sort()).toEqual(["curated", "observations", "reflections"]);
  });
});

describe("resolved scope and access are pinned to the request", () => {
  test("refuses a resolved scope that differs from the request", () => {
    const candidate = baseResult();
    expect(
      decodeResult({
        ...candidate,
        resolvedScope: { ...candidate.resolvedScope, workstream: "other" },
      })._tag,
    ).toBe("Left");
  });

  test("refuses a resolved access that differs from the request", () => {
    const candidate = baseResult();
    expect(
      decodeResult({
        ...candidate,
        resolvedAccess: { ...candidate.resolvedAccess, purpose: "something else" },
      })._tag,
    ).toBe("Left");
    expect(
      decodeResult({
        ...candidate,
        resolvedAccess: { ...candidate.resolvedAccess, allowedPrivacy: ["private", "public"] },
      })._tag,
    ).toBe("Left");
  });
});

describe("lane invariants", () => {
  test("refuses a retrieval-scope item whose scope is not the resolved scope", () => {
    const candidate = baseResult();
    const drifted = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        curatedPages: {
          ...availableLane("curated-pages", [
            {
              ...laneItem("curated-pages", 1, "brain-1", 3.2),
              kind: "brain_pages",
              scope: { _tag: "ProjectWorkstream" as const, project: "elsewhere", workstream: "x" },
              scopeBinding: "retrieval-scope",
            },
          ]),
        },
      },
    };
    expect(decodeResult(drifted)._tag).toBe("Left");
  });

  test("refuses a lane carrying another lane's score scale", () => {
    const candidate = baseResult();
    const swapped = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        flowingReflections: {
          ...candidate.lanes.flowingReflections,
          scoreScale: "bm25-negated",
        },
      },
    };
    expect(decodeResult(swapped)._tag).toBe("Left");
  });

  test("refuses a lane holding more items than the request asked for", () => {
    const candidate = baseResult();
    const overRequested = {
      ...candidate,
      request: { ...request, limits: { ...request.limits, reflections: 1 } },
      lanes: candidate.lanes,
    };
    expect(decodeResult(overRequested)._tag).toBe("Left");
  });

  test("refuses a flowing item with no evidence, and allows a curated page without any", () => {
    const candidate = baseResult();
    const noEvidence = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        flowingReflections: availableLane("flowing-reflections", [
          { ...laneItem("flowing-reflections", 1, "r1", 0.9), evidenceIds: [] },
        ]),
      },
    };
    expect(decodeResult(noEvidence)._tag).toBe("Left");

    const curatedWithoutEvidence = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        curatedPages: availableLane("curated-pages", [
          {
            ...laneItem("curated-pages", 1, "brain-1", 3.2),
            evidenceIds: [],
            kind: "brain_pages",
            scopeBinding: "retrieval-scope",
          },
        ]),
      },
    };
    expect(decodeResult(curatedWithoutEvidence)._tag).toBe("Right");
  });
});

describe("lane health preserves what the producer reported", () => {
  test("keeps stale build and freshness times", () => {
    const candidate = baseResult();
    const stale = {
      ...candidate,
      lanes: {
        ...candidate.lanes,
        flowingObservations: {
          ...availableLane("flowing-observations", []),
          health: {
            _tag: "Stale" as const,
            builtAt: "2026-08-20T00:00:00.000Z",
            detail: "flowing projection is behind its source",
            freshAt: "2026-08-21T00:00:00.000Z",
            sourceSnapshotHash: hexDigest,
            staleSince: "2026-08-22T00:00:00.000Z",
          },
        },
      },
    };
    const decoded = decodeResult(stale);
    expect(decoded._tag).toBe("Right");
    if (decoded._tag !== "Right") return;
    const health = decoded.right.lanes.flowingObservations;
    if (health._tag !== "RecallLaneAvailableV1" || health.health._tag !== "Stale") {
      throw new Error("expected a stale available lane");
    }
    expect(health.health.builtAt).toBe("2026-08-20T00:00:00.000Z");
    expect(health.health.freshAt).toBe("2026-08-21T00:00:00.000Z");
  });

  test("keeps the failure receipt ID and last valid snapshot, and refuses a noncanonical one", () => {
    const candidate = baseResult();
    const failedWith = (failureReceiptId: string) => ({
      ...candidate,
      lanes: {
        ...candidate.lanes,
        flowingObservations: {
          ...availableLane("flowing-observations", []),
          health: {
            _tag: "Failed" as const,
            detail: "flowing projection failed",
            failureReceiptId,
            lastValidSnapshotHash: hexDigest,
          },
        },
      },
    });

    const decoded = decodeResult(failedWith(`failure:${hexDigest}`));
    expect(decoded._tag).toBe("Right");
    if (decoded._tag !== "Right") return;
    const lane = decoded.right.lanes.flowingObservations;
    if (lane._tag !== "RecallLaneAvailableV1" || lane.health._tag !== "Failed") {
      throw new Error("expected a failed available lane");
    }
    expect(lane.health.failureReceiptId).toBe(`failure:${hexDigest}`);
    expect(lane.health.lastValidSnapshotHash).toBe(hexDigest);

    expect(decodeResult(failedWith("not-a-canonical-failure-id"))._tag).toBe("Left");
  });
});
