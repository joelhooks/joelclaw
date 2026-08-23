/**
 * Curated recall port tests. Nothing here opens the production `critical.db`.
 */

import { describe, expect, test } from "bun:test";
import { CriticalDbUnavailableError } from "../lib/critical-search";
import { CURATED_RECALL_COLLECTIONS, readCuratedRecall } from "./curated-port";
import { curatedSearchResult, testRequest } from "./test-fixtures";

type SearchCall = {
  query: string;
  limit?: number;
  collections?: readonly string[];
  privacy?: readonly string[];
};

describe("the curated port's query", () => {
  test("asks the local database for exactly the three curated collections", async () => {
    const calls: SearchCall[] = [];
    await readCuratedRecall({
      request: testRequest(),
      search: (input) => {
        calls.push(input);
        return curatedSearchResult([{ id: "brain-1" }]);
      },
    });

    expect(calls[0]?.collections).toEqual([...CURATED_RECALL_COLLECTIONS]);
    expect(calls[0]?.collections).not.toContain("observations");
    expect(calls[0]?.collections).not.toContain("memory_observations");
  });

  test("pushes the privacy grant into the query, not into a post-filter alone", async () => {
    const calls: SearchCall[] = [];
    await readCuratedRecall({
      request: testRequest({
        access: {
          _tag: "RecallAccessV1",
          allowedPrivacy: ["public", "private"],
          decidedAt: "2026-08-22T00:00:00.000Z",
          principalRef: "operator:joel",
          purpose: "recall-adapter-comparison",
        },
      }),
      search: (input) => {
        calls.push(input);
        return curatedSearchResult([]);
      },
    });

    expect(calls[0]?.privacy).toEqual(["public", "private"]);
  });

  test("asks for exactly the requested limit, because the filter is now in SQL", async () => {
    const calls: SearchCall[] = [];
    await readCuratedRecall({
      request: testRequest({ limits: { curated: 3, observations: 5, reflections: 5 } }),
      search: (input) => {
        calls.push(input);
        return curatedSearchResult([]);
      },
    });

    expect(calls[0]?.limit).toBe(3);
  });
});

describe("the curated lane", () => {
  test("binds curated pages to the retrieval scope, never to a record scope", async () => {
    const outcome = await readCuratedRecall({
      request: testRequest(),
      search: () => curatedSearchResult([{ id: "brain-1" }]),
    });

    if (outcome.lane._tag !== "RecallLaneAvailableV1") throw new Error("expected an available lane");
    expect(outcome.lane.items[0]?.scopeBinding).toBe("retrieval-scope");
    expect(outcome.lane.items[0]?.scope.project).toBe(
      testRequest().scope.project,
    );
    expect(outcome.lane.scoreScale).toBe("bm25-negated");
  });

  test("still drops a disallowed row if the store ever returns one", async () => {
    const outcome = await readCuratedRecall({
      request: testRequest(),
      search: () =>
        curatedSearchResult([
          { id: "brain-1", privacy: "private" },
          { id: "brain-2", privacy: "sensitive" },
        ]),
    });

    if (outcome.lane._tag !== "RecallLaneAvailableV1") throw new Error("expected an available lane");
    expect(outcome.lane.items.map((item) => item.id)).toEqual(["brain-1"]);
  });

  test("still drops a row from a collection it did not ask for", async () => {
    const outcome = await readCuratedRecall({
      request: testRequest(),
      search: () =>
        curatedSearchResult([
          { id: "obs-1", collection: "observations" },
          { id: "brain-1" },
        ]),
    });

    if (outcome.lane._tag !== "RecallLaneAvailableV1") throw new Error("expected an available lane");
    expect(outcome.lane.items.map((item) => item.id)).toEqual(["brain-1"]);
  });

  test("never carries the page body into the lane", async () => {
    const outcome = await readCuratedRecall({
      request: testRequest(),
      search: () => curatedSearchResult([{ id: "brain-1" }]),
    });

    expect(JSON.stringify(outcome.lane)).not.toContain("body text that must never reach a receipt");
  });

  test("reports an unavailable store without quoting its filesystem path", async () => {
    const outcome = await readCuratedRecall({
      request: testRequest(),
      search: () => {
        throw new CriticalDbUnavailableError("critical.db not found: /Users/joel/.joelclaw/critical.db");
      },
    });

    if (outcome.lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(outcome.lane.code).toBe("store-unavailable");
    expect(outcome.lane.message).not.toContain("/Users/joel");
  });

  test("marks a degraded projection stale rather than healthy", async () => {
    const base = curatedSearchResult([{ id: "brain-1" }]);
    const outcome = await readCuratedRecall({
      request: testRequest(),
      search: () => ({
        ...base,
        freshness: { ...base.freshness, status: "degraded", coverageGaps: ["brain", "vault"] },
      }),
    });

    if (outcome.lane._tag !== "RecallLaneAvailableV1") throw new Error("expected an available lane");
    expect(outcome.lane.health._tag).toBe("Stale");
  });
});
