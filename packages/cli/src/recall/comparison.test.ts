/**
 * Comparison receipt tests.
 *
 * The receipt is written for a blind operator. These tests hold it to that:
 * every fact it needs is present, and the question, the principal, the purpose,
 * the bodies, the paths, and the backend diagnostics are not.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  backendKindOf,
  type ComposedRunOutcome,
  comparisonIsComplete,
  evaluateContractCorrectness,
  isValidCaseId,
  type OldBackendCaller,
  RECEIPT_CASE_ID_PATTERN,
  registeredComposedRunner,
  runRecallComparison,
  safeCaseId,
  safeFailureCode,
  safeFreshnessStatus,
  writeRecallComparisonReceipt,
} from "./comparison";
import { composeRecall } from "./composer";
import { type ComposedRecallResultV1, encodeComposedRecallResult } from "./contract";
import {
  curatedSearchResult,
  flowingSuccessEnvelope,
  flowingUnavailableEnvelope,
  TEST_FLOWING_CONFIG,
  TEST_SECRET,
  testRequest,
} from "./test-fixtures";

const request = testRequest();

const QUERY_TEXT = request.text;
const PRINCIPAL = request.access.principalRef;
const PURPOSE = request.access.purpose;

function composedRunner(options: { stdout?: string; curatedThrows?: boolean } = {}) {
  return async (): Promise<ComposedRunOutcome> => {
    const outcome = await composeRecall({
      request,
      flowingConfig: TEST_FLOWING_CONFIG,
      runProcess: async () => ({
        exitCode: options.stdout ? 0 : 0,
        stdout: options.stdout ?? JSON.stringify(flowingSuccessEnvelope()),
        stderr: "",
        timedOut: false,
        missingExecutable: false,
      }),
      leaseCredential: async () => ({ ok: true, value: TEST_SECRET }),
      curatedSearch: () => {
        if (options.curatedThrows) {
          throw new Error("critical.db not found: /Users/joel/.joelclaw/critical.db");
        }
        return curatedSearchResult([{ id: "brain-1" }]);
      },
      parentEnv: {},
    });
    return {
      result: outcome.result,
      timings: outcome.timings,
      curatedBackend: outcome.curatedBackend,
    };
  };
}

function fakeOldBackends(calls: string[]): readonly OldBackendCaller[] {
  return [
    {
      caller: "cli-sqlite-first",
      adapter: "typesense-recall",
      run: async (args) => {
        calls.push(`cli:${args.query}`);
        return {
          payload: {
            backend: "sqlite-fts5 via /Users/joel/.joelclaw/critical.db",
            freshness: { status: "ok" },
            hits: [
              { id: "brain-1", collection: "brain_pages", score: 3.2, privacy: "private", path: "/x/joelclaw-memory/a.svx" },
              { id: "old-2", collection: "observations", score: 1.1, privacy: "private", path: "/x/other-repo/b.svx" },
            ],
          },
        };
      },
    },
    {
      caller: "sdk-in-process-typesense",
      adapter: "typesense-recall",
      run: async (args) => {
        calls.push(`sdk:${args.query}`);
        return {
          payload: {
            backend: "typesense@https://search.internal.example",
            hits: [{ id: "brain-1", collection: "brain_pages", score: 0.8, privacy: "private" }],
          },
        };
      },
    },
  ];
}

async function receiptFor(options: Parameters<typeof composedRunner>[0] = {}, calls: string[] = []) {
  return runRecallComparison({
    request,
    caseId: "case-2026-08-22-a",
    now: new Date("2026-08-22T12:00:00.000Z"),
    oldBackends: fakeOldBackends(calls),
    composed: composedRunner(options),
  });
}

describe("what the receipt records", () => {
  test("calls both current backends with old recall vocabulary", async () => {
    const calls: string[] = [];
    const receipt = await receiptFor({}, calls);
    expect(calls).toEqual([`cli:${QUERY_TEXT}`, `sdk:${QUERY_TEXT}`]);
    expect(receipt.old.map((entry) => entry.caller)).toEqual([
      "cli-sqlite-first",
      "sdk-in-process-typesense",
    ]);
  });

  test("identifies the case and hashes the question instead of storing it", async () => {
    const receipt = await receiptFor();
    expect(receipt.caseId).toMatch(RECEIPT_CASE_ID_PATTERN);
    expect(receipt.request.querySha256).toBe(
      createHash("sha256").update(QUERY_TEXT, "utf8").digest("hex"),
    );
    expect(receipt.request.queryLength).toBe(QUERY_TEXT.length);
    expect(receipt.request.access.principalRefSha256).toBe(
      createHash("sha256").update(PRINCIPAL, "utf8").digest("hex"),
    );
    expect(receipt.request.access.purposeSha256).toBe(
      createHash("sha256").update(PURPOSE, "utf8").digest("hex"),
    );
  });

  test("keeps the exact scope, privacy grant, decision time, and supersession choice", async () => {
    const receipt = await receiptFor();
    expect(receipt.request.scope).toEqual({
      project: request.scope.project,
      workstream: request.scope.workstream,
    });
    expect(receipt.request.access.allowedPrivacy).toEqual(["private"]);
    expect(receipt.request.access.decidedAt).toBe(request.access.decidedAt);
    expect(receipt.request.includeSuperseded).toBe(false);
    expect(receipt.request.limits).toEqual({ curated: 5, observations: 5, reflections: 5 });
  });

  test("records ordered identity, ranks, scores, and evidence for every lane", async () => {
    const receipt = await receiptFor();
    const reflections = receipt.composed.lanes.find(
      (lane) => lane.lane === "flowing-reflections",
    );
    expect(reflections?.items.map((item) => item.rank)).toEqual([1, 2]);
    expect(reflections?.items[0]?.evidenceIds?.length).toBe(1);
    expect(reflections?.evidenceIdCount).toBe(2);
    expect(reflections?.itemsMissingEvidence).toBe(0);
    expect(reflections?.health?.status).toBe("Healthy");
  });

  test("records overlap and duplicates across the three paths", async () => {
    const receipt = await receiptFor();
    expect(receipt.overlap.cliVsSdkSharedIds).toBe(1);
    expect(receipt.overlap.cliOnlyIds).toBe(1);
    expect(receipt.overlap.composedVsCliSharedIds).toBe(1);
    expect(receipt.old[0]?.outOfScopeHitCount).toBe(1);
    expect(receipt.old[0]?.duplicateIdCount).toBe(0);
  });

  test("reduces backend names to a kind so a host or endpoint never lands in the receipt", async () => {
    const receipt = await receiptFor();
    expect(receipt.old[0]?.backendKind).toBe("sqlite");
    expect(receipt.old[1]?.backendKind).toBe("typesense");
    expect(backendKindOf("typesense@https://search.internal.example")).toBe("typesense");

    const json = JSON.stringify(receipt);
    expect(json).not.toContain("search.internal.example");
    expect(json).not.toContain("/Users/joel");
  });

  test("never carries the question, the principal, the purpose, or any body", async () => {
    const receipt = await receiptFor();
    const json = JSON.stringify(receipt);
    expect(json).not.toContain(QUERY_TEXT);
    expect(json).not.toContain(PRINCIPAL);
    expect(json).not.toContain(PURPOSE);
    expect(json).not.toContain("body text that must never reach a receipt");
    expect(json).not.toContain("reflection claim");
    expect(json).not.toContain(TEST_SECRET);
  });

  test("stores a typed lane code instead of the lane's message", async () => {
    const receipt = await receiptFor({ stdout: "not json" });
    const lane = receipt.composed.lanes.find((entry) => entry.lane === "flowing-reflections");
    expect(lane?.available).toBe(false);
    expect(lane?.unavailableCode).toBe("malformed-response");
    expect(JSON.stringify(receipt)).not.toContain("did not match the flowing-memory read envelope");
  });
});

describe("the two verdicts", () => {
  test("a canonical composed result is contract-correct with no reasons", async () => {
    const receipt = await receiptFor();
    expect(receipt.contractCorrect).toEqual({ status: "pass", reasons: [] });
  });

  test("usefulness is left unjudged and carries the metrics a human needs", async () => {
    const receipt = await receiptFor();
    expect(receipt.useful.status).toBe("unjudged");
    expect(receipt.useful.metrics.composedItemCount).toBe(4);
    expect(receipt.useful.metrics.flowingItemsWithEvidence).toBe(3);
    expect(receipt.useful.metrics.flowingItemsMissingEvidence).toBe(0);
    expect(receipt.useful.metrics.distinctEvidenceIds).toBe(3);
    expect(receipt.useful.metrics.curatedItemCount).toBe(1);
    expect(receipt.useful.metrics.cliHitCount).toBe(2);
    expect(receipt.useful.metrics.sdkHitCount).toBe(1);
    expect(receipt.useful.metrics.oldOutOfScopeHitCount).toBe(1);
  });

  test("names each contract defect by a stable reason code", () => {
    const base = {
      _tag: "ComposedRecallResultV1",
      lanes: {
        curatedPages: {
          _tag: "RecallLaneAvailableV1",
          health: { _tag: "Healthy" },
          items: [],
          lane: "curated-pages",
          scoreScale: "bm25-negated",
          source: "test",
        },
        flowingObservations: {
          _tag: "RecallLaneAvailableV1",
          health: { _tag: "Healthy" },
          items: [],
          lane: "flowing-observations",
          scoreScale: "unit-interval",
          source: "test",
        },
        flowingReflections: {
          _tag: "RecallLaneAvailableV1",
          health: { _tag: "Healthy" },
          items: [
            {
              evidenceIds: [],
              id: "reflection:v1:a",
              kind: "reflection",
              lane: "flowing-reflections",
              privacy: "sensitive",
              rank: 2,
              scope: { _tag: "ProjectWorkstream", project: "other.repo", workstream: "main" },
              scopeBinding: "record-scope",
              score: 0.9,
              title: "x",
            },
          ],
          lane: "flowing-reflections",
          scoreScale: "unit-interval",
          source: "test",
        },
      },
      request,
      resolvedAccess: request.access,
      resolvedScope: request.scope,
      schemaVersion: 1,
      unavailable: [],
    } as unknown as ComposedRecallResultV1;

    const verdict = evaluateContractCorrectness(base, request);
    expect(verdict.status).toBe("fail");
    expect([...verdict.reasons].sort()).toEqual([
      "flowing-reflections:item-without-evidence",
      "flowing-reflections:privacy-outside-grant",
      "flowing-reflections:rank-not-sequential-from-one",
      "flowing-reflections:record-scope-outside-request",
    ]);
  });

  test("is unjudged when the composed adapter never answered", async () => {
    const receipt = await runRecallComparison({
      request,
      now: new Date("2026-08-22T12:00:00.000Z"),
      oldBackends: fakeOldBackends([]),
      composed: async () => {
        throw Object.assign(new Error("boom at /Users/joel/x"), { code: "COMPOSED_RECALL_FAILED" });
      },
    });

    expect(receipt.composed.ok).toBe(false);
    expect(receipt.composed.failureCode).toBe("COMPOSED_RECALL_FAILED");
    expect(receipt.contractCorrect.status).toBe("unjudged");
    expect(JSON.stringify(receipt)).not.toContain("/Users/joel");
  });
});

describe("completeness", () => {
  test("a run where every lane and backend answered is complete", async () => {
    expect(comparisonIsComplete(await receiptFor())).toBe(true);
  });

  test("an unavailable lane makes the run incomplete", async () => {
    const receipt = await receiptFor({ curatedThrows: true });
    expect(receipt.composed.unavailableLanes).toEqual(["curated-pages"]);
    expect(comparisonIsComplete(receipt)).toBe(false);
  });

  test("a failing current backend makes the run incomplete", async () => {
    const receipt = await runRecallComparison({
      request,
      now: new Date("2026-08-22T12:00:00.000Z"),
      oldBackends: [
        {
          caller: "cli-sqlite-first",
          adapter: "typesense-recall",
          run: async () => {
            throw Object.assign(new Error("down"), { code: "RECALL_BACKEND_UNAVAILABLE" });
          },
        },
      ],
      composed: composedRunner(),
    });

    expect(receipt.old[0]?.ok).toBe(false);
    expect(receipt.old[0]?.failureCode).toBe("RECALL_BACKEND_UNAVAILABLE");
    expect(comparisonIsComplete(receipt)).toBe(false);
  });
});

describe("writing the receipt", () => {
  test("writes 0600 and refuses to overwrite an existing path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recall-receipt-"));
    const path = join(directory, "nested", "receipt.json");
    const receipt = await receiptFor();

    await writeRecallComparisonReceipt(path, receipt);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))._tag).toBe("RecallComparisonReceiptV1");

    await expect(writeRecallComparisonReceipt(path, receipt)).rejects.toThrow();
  });

  test("refuses a path that already exists as a planted file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recall-receipt-"));
    const path = join(directory, "planted.json");
    writeFileSync(path, "{}");
    await expect(writeRecallComparisonReceipt(path, await receiptFor())).rejects.toThrow();
  });
});

describe("the production composition root", () => {
  test("runs the registered adapter and decodes its composed result", async () => {
    let sawArgs: Record<string, unknown> | undefined;
    // A real composed result, encoded exactly as the adapter emits it.
    const encoded = encodeComposedRecallResult(
      (
        await composeRecall({
          request,
          curatedSearch: () => curatedSearchResult([{ id: "brain-1" }]),
          parentEnv: {},
        })
      ).result,
    );
    const runner = registeredComposedRunner({
      cwd: mkdtempSync(join(tmpdir(), "recall-cwd-")),
      port: {
        capability: "recall",
        adapter: "flowing-memory-recall",
        commands: {},
        execute: (_subcommand, args) => {
          sawArgs = args as Record<string, unknown>;
          return Effect.succeed({
            raw: false,
            payload: {
              adapter: "flowing-memory-recall",
              composed: encoded,
              curatedBackend: "sqlite-fts5",
              timings: { flowingMs: 1, curatedMs: 2, totalMs: 3 },
            },
          }) as never;
        },
      },
    });

    const outcome = await runner(request);
    expect(sawArgs?.project).toBe(request.scope.project);
    expect(sawArgs?.reflectionLimit).toBe(5);
    expect(sawArgs).not.toHaveProperty("legacyLimit");
    expect(outcome.curatedBackend).toBe("sqlite-fts5");
    expect(outcome.result._tag).toBe("ComposedRecallResultV1");
  });
});


describe("the receipt refuses caller- and backend-controlled text", () => {
  const privateQuestion = "what did we decide about the postgres migration on 2026-08-19?";

  test("a query-shaped case ID is hashed, never stored", () => {
    const stored = safeCaseId(privateQuestion, privateQuestion);
    expect(stored).not.toContain("postgres");
    expect(stored).not.toContain(" ");
    expect(stored).toMatch(RECEIPT_CASE_ID_PATTERN);
    expect(isValidCaseId(stored)).toBe(true);
    // Stable: the same bad label still correlates two runs.
    expect(safeCaseId(privateQuestion, privateQuestion)).toBe(stored);
  });

  test("a path-shaped or punctuation-carrying case ID is refused", () => {
    for (const supplied of [
      "/Users/joel/.joelclaw/critical.db",
      "case id with spaces",
      "-leading-dash",
      "a".repeat(65),
      "case/with/slashes",
    ]) {
      expect(isValidCaseId(supplied)).toBe(false);
      expect(safeCaseId(supplied, privateQuestion)).toMatch(RECEIPT_CASE_ID_PATTERN);
    }
  });

  test("even a well-formed caller label is hashed, not copied", () => {
    // `--case-id` is short free text, and a short slug is where a question, a
    // customer name, or a project code gets typed. The CLI accepting it is not
    // a reason to store it.
    const stored = safeCaseId("recall-2026-08-22.a_1", privateQuestion);
    expect(stored).not.toContain("recall-2026-08-22");
    expect(stored).toMatch(RECEIPT_CASE_ID_PATTERN);
    expect(safeCaseId("recall-2026-08-22.a_1", privateQuestion)).toBe(stored);
  });

  test("a short slug that is itself the question is never recoverable from the receipt", () => {
    for (const slug of ["postgres", "acme-corp", "layoffs", "ceo.health", "SEV1_outage"]) {
      // Every one of these passes the CLI shape rule.
      expect(isValidCaseId(slug)).toBe(true);
      const stored = safeCaseId(slug, privateQuestion);
      expect(stored).toMatch(RECEIPT_CASE_ID_PATTERN);
      expect(stored.toLowerCase()).not.toContain(slug.toLowerCase().replaceAll(/[._-]/gu, ""));
      expect(stored).not.toContain(slug);
    }
  });

  test("a supplied label and a derived key never collide on the same text", () => {
    expect(safeCaseId(privateQuestion, privateQuestion)).not.toBe(
      safeCaseId(undefined, privateQuestion),
    );
  });

  test("an absent case ID derives one from the query hash without storing the query", () => {
    const derived = safeCaseId(undefined, privateQuestion);
    expect(derived).toMatch(RECEIPT_CASE_ID_PATTERN);
    expect(derived).not.toContain("postgres");
  });

  test("a path-shaped or query-shaped backend code becomes UNKNOWN", () => {
    for (const code of [
      "/Users/joel/.joelclaw/critical.db is unreadable",
      "postgres search index",
      "SELECT * FROM documents",
      "connect ECONNREFUSED 10.0.0.4:8108",
      "",
      "  ",
      "A".repeat(80),
    ]) {
      expect(safeFailureCode(code)).toBe("UNKNOWN");
    }
    expect(safeFailureCode(undefined)).toBe("UNKNOWN");
    expect(safeFailureCode({ toString: () => "ENOENT" })).toBe("UNKNOWN");
  });

  test("a stable machine code survives", () => {
    expect(safeFailureCode("ENOENT")).toBe("ENOENT");
    expect(safeFailureCode("SQLITE_CANTOPEN")).toBe("SQLITE_CANTOPEN");
    expect(safeFailureCode("RECALL_SUBCOMMAND_UNSUPPORTED")).toBe("RECALL_SUBCOMMAND_UNSUPPORTED");
  });

  test("a house-shaped code that is not a known code becomes UNKNOWN", () => {
    // These all satisfy any reasonable shape rule for a house code. None of
    // them is a code this system emits, so each one is a label somebody chose,
    // and a label somebody chose can carry a customer name.
    for (const code of [
      "RECALL_CUSTOMER_SECRET_ALPHA",
      "RECALL_ACME_CORP_TENANT",
      "COMPOSED_RECALL_JOEL_PRIVATE",
      "SQLITE_USERS_TABLE",
      "ERR_INTERNAL_PROJECT_NAME",
      "ECUSTOM",
    ]) {
      expect(safeFailureCode(code)).toBe("UNKNOWN");
    }
  });

  test("an unknown freshness label becomes UNKNOWN", () => {
    expect(safeFreshnessStatus("ok")).toBe("ok");
    expect(safeFreshnessStatus("STALE")).toBe("stale");
    expect(safeFreshnessStatus("behind by /var/db/critical.db")).toBe("UNKNOWN");
    expect(safeFreshnessStatus(42)).toBe("UNKNOWN");
  });

  test("a backend that throws a path-shaped code writes UNKNOWN into the receipt", async () => {
    const receipt = await runRecallComparison({
      request: testRequest(),
      caseId: privateQuestion,
      composed: async () => {
        throw Object.assign(new Error("boom"), {
          code: "/Users/joel/.joelclaw/critical.db missing",
        });
      },
      oldBackends: [
        {
          caller: "cli-sqlite-first",
          adapter: "typesense-recall",
          run: async () => {
            throw Object.assign(new Error("boom"), { code: "postgres search index" });
          },
        },
      ],
    });

    const serialized = JSON.stringify(receipt);
    expect(receipt.old[0]?.failureCode).toBe("UNKNOWN");
    expect(receipt.composed.failureCode).toBe("UNKNOWN");
    expect(receipt.caseId).toMatch(RECEIPT_CASE_ID_PATTERN);
    expect(serialized).not.toContain("postgres");
    expect(serialized).not.toContain("/Users/joel");
    expect(serialized).not.toContain("critical.db");
  });
});
