/**
 * Flowing recall port tests.
 *
 * Every process boundary is faked. The canonical fixtures come from
 * `test-fixtures.ts` and satisfy the full v1 contract; each defect test mutates
 * exactly one field of a canonical fixture, so a rejection is attributable.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemorySearchQueryPayload,
  DEFAULT_FLOWING_TIMEOUT_MS,
  FLOWING_READ_ARGS,
  inspectFlowingRecallPortSettings,
  PRIVATE_LEGACY_LIMIT,
  readFlowingRecall,
  resolveFlowingRecallPortConfig,
  verifyTrustedExecutable,
} from "./flowing-port";
import type { BoundaryProcessRequest, BoundaryProcessResult } from "./process-boundary";
import {
  flowingQueryWire,
  flowingSuccessEnvelope,
  flowingUnavailableEnvelope,
  hex,
  legacyHitWire,
  observationHitWire,
  reflectionHitWire,
  TEST_FLOWING_CONFIG,
  TEST_SECRET,
  testRelease,
  testReleaseSeams,
  testRequest,
  withUnsealedRelease,
} from "./test-fixtures";

function trustedRoot(): { root: string; executable: string; sha256: string } {
  const release = testRelease();
  return { root: release.root, executable: release.executable, sha256: release.sha256 };
}

const okProcess = (overrides: Partial<BoundaryProcessResult> = {}): BoundaryProcessResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  missingExecutable: false,
  ...overrides,
});

interface HarnessOptions {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly process?: Partial<BoundaryProcessResult>;
  readonly lease?: { ok: false; message: string } | { ok: true; value: string };
  readonly config?: Partial<typeof TEST_FLOWING_CONFIG>;
}

function harness(options: HarnessOptions = {}) {
  const seen: BoundaryProcessRequest[] = [];
  const config = { ...TEST_FLOWING_CONFIG, ...options.config };
  return {
    seen,
    run: (request = testRequest()) =>
      readFlowingRecall({
        request,
        config,
        parentEnv: { PATH: "/usr/bin", HOME: "/Users/test", AWS_SECRET_ACCESS_KEY: "unrelated" },
        leaseCredential: async () => options.lease ?? { ok: true, value: TEST_SECRET },
        runProcess: async (processRequest) => {
          seen.push(processRequest);
          return okProcess({
            stdout: options.stdout ?? "",
            exitCode: options.exitCode ?? 0,
            ...options.process,
          });
        },
      }),
  };
}

const successStdout = (envelope: Record<string, unknown>) => JSON.stringify(envelope);

const sha256Of = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("resolveFlowingRecallPortConfig", () => {
  test("status inspection checks structure without hashing an artifact", () => {
    expect(
      inspectFlowingRecallPortSettings({
        read_executable: "/not-read-or-hashed/by-status",
        credential_secret_name: "flowing-runtime-url",
        credential_format: "raw",
      }),
    ).toEqual({ ok: true });
  });

  test("is safe when nothing is configured", () => {
    const outcome = resolveFlowingRecallPortConfig({ settings: undefined });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("not-configured");
  });

  test("accepts an executable inside the trusted release root and owns its arguments", () => {
    const { root, executable, sha256 } = trustedRoot();
    const outcome = resolveFlowingRecallPortConfig({
      settings: { read_executable: executable, credential_secret_name: "flowing-runtime-url" },
      trustedReleaseRoot: root,
      expectedArtifactSha256: sha256,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The path holds a space. Nothing split it.
      expect(outcome.config.readExecutable).toContain("2026-08-22 build");
      expect(outcome.config.readArgs).toEqual(FLOWING_READ_ARGS);
      expect(outcome.config.credentialFormat).toBe("raw");
      expect(outcome.config.timeoutMs).toBe(DEFAULT_FLOWING_TIMEOUT_MS);
    }
  });

  test("refuses an executable outside the trusted release root", () => {
    const { root } = trustedRoot();
    const outside = mkdtempSync(join(tmpdir(), "flowing-elsewhere-"));
    const executable = join(outside, "joelclaw-memory");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");

    const outcome = resolveFlowingRecallPortConfig({
      settings: { read_executable: executable, credential_secret_name: "flowing-runtime-url" },
      trustedReleaseRoot: root,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("untrusted-executable");
  });

  test("refuses a directory and a path that does not exist", () => {
    const { root } = trustedRoot();
    const directory = join(root, "2026-08-22 build");

    const directoryResult = verifyTrustedExecutable(directory, root);
    const missingResult = verifyTrustedExecutable(join(root, "missing"), root);

    expect(directoryResult.ok === false && directoryResult.code).toBe("untrusted-executable");
    expect(missingResult.ok === false && missingResult.code).toBe("not-configured");
  });

  test("requires a credential secret name and a known credential format", () => {
    const { root, executable, sha256 } = trustedRoot();
    const missingName = resolveFlowingRecallPortConfig({
      settings: { read_executable: executable },
      trustedReleaseRoot: root,
      expectedArtifactSha256: sha256,
    });
    expect(missingName.ok).toBe(false);
    if (!missingName.ok) expect(missingName.code).toBe("not-configured");

    const badFormat = resolveFlowingRecallPortConfig({
      settings: {
        read_executable: executable,
        credential_secret_name: "flowing-runtime-url",
        credential_format: "yaml",
      },
      trustedReleaseRoot: root,
      expectedArtifactSha256: sha256,
    });
    expect(badFormat.ok).toBe(false);
  });
});

describe("the stdin payload", () => {
  test("carries the exact query and a private legacy limit of one", () => {
    const payload = buildMemorySearchQueryPayload(testRequest());
    expect(payload.legacyLimit).toBe(PRIVATE_LEGACY_LIMIT);
    expect(payload.legacyLimit).toBe(1);
    expect(payload.reflectionLimit).toBe(5);
    expect(payload.text).toBe("postgres search index");
  });

  test("never places the query or the credential in argv", async () => {
    const port = harness({ stdout: successStdout(flowingSuccessEnvelope()) });
    await port.run();

    const request = port.seen[0];
    expect(request?.command).toEqual([
      TEST_FLOWING_CONFIG.readExecutable,
      "flowing-recall-read-v2",
      "--query-file",
      "-",
    ]);
    const argv = (request?.command ?? []).join(" ");
    expect(argv).not.toContain("postgres search index");
    expect(argv).not.toContain(TEST_SECRET);
    expect(JSON.parse(request?.stdin ?? "{}").text).toBe("postgres search index");
  });

  test("hands the child the credential in the environment and nothing else from the parent", async () => {
    const port = harness({ stdout: successStdout(flowingSuccessEnvelope()) });
    await port.run();

    expect(port.seen[0]?.env).toEqual({
      TERM: "dumb",
      PATH: "/usr/bin",
      HOME: "/Users/test",
      JOELCLAW_MEMORY_RUNTIME_DATABASE_URL: TEST_SECRET,
    });
  });
});

describe("successful reads", () => {
  test("produces two flowing lanes and never a legacy lane", async () => {
    const port = harness({
      stdout: successStdout(flowingSuccessEnvelope({ legacyCount: 1 })),
    });
    const outcome = await port.run();

    expect(Object.keys(outcome.lanes).sort()).toEqual([
      "curated-pages",
      "flowing-observations",
      "flowing-reflections",
    ]);
    const reflections = outcome.lanes["flowing-reflections"];
    expect(reflections._tag).toBe("RecallLaneAvailableV1");
    if (reflections._tag === "RecallLaneAvailableV1") {
      expect(reflections.items).toHaveLength(2);
      expect(reflections.items[0]?.id).toBe(`reflection:v1:${hex(1)}`);
      expect(reflections.items[0]?.evidenceIds).toEqual([`evidence:${hex(1)}`]);
      expect(reflections.scoreScale).toBe("unit-interval");
    }
    // A decoded legacy hit was present in the envelope and reached no lane.
    const laneJson = JSON.stringify(outcome.lanes);
    expect(laneJson).not.toContain("legacy");
  });

  test("decodes the producer-generated ReflectionV2 fixture", async () => {
    const fixture = readFileSync(
      new URL("./fixtures/reviewed-card-v2-envelope.json", import.meta.url),
      "utf8",
    );
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(
      "31f2a05a3df5f3985fce48485c6f2625bfdcd89ed79a46e7de95b1f4594bc8c2",
    );
    const port = harness({ stdout: fixture });
    const outcome = await port.run(
      testRequest({
        access: {
          _tag: "RecallAccessV1",
          allowedPrivacy: ["private"],
          decidedAt: "2026-08-28T03:10:00.000Z",
          principalRef: "producer-fixture",
          purpose: "consumer contract parity",
          schemaVersion: 1,
        },
        scope: {
          _tag: "ProjectWorkstream",
          project: "joelclaw-fleet",
          workstream: "default",
        },
        text: "pane identity",
      }),
    );
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneAvailableV1") {
      throw new Error(`expected an available lane: ${JSON.stringify(lane)}`);
    }
    expect(lane.items[0]).toMatchObject({
      id: "reflection:v2:fd4aa57046adbbb8760f37da7866c19087cea967f97214bfced26ddf5241439b",
      title: "A pane ID is only a locator claim.",
    });
    expect(lane.items[0]?.summary).toContain("Kernel peer identity");
    expect(lane.items[0]?.summary).toContain("Windows named-pipe PID");
  });

  test("renders a ReflectionV2 card as trigger plus behavior consequence", async () => {
    const port = harness({
      stdout: successStdout(flowingSuccessEnvelope({ cardCount: 1, reflectionCount: 0 })),
    });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneAvailableV1") {
      throw new Error("expected an available lane");
    }
    expect(lane.items[0]).toMatchObject({
      id: `reflection:v2:${hex(0x80)}`,
      title: "When a Herdr pane ID is used as dispatch authority.",
    });
    expect(lane.items[0]?.summary).toContain(
      "Fail closed when Windows named-pipe PID proof is unavailable.",
    );
    expect(lane.items[0]?.summary).toStartWith("Consequence:");
  });

  test("keeps the full maximum-size consequence in the bounded card summary", async () => {
    const envelope = flowingSuccessEnvelope({ cardCount: 1, reflectionCount: 0 });
    const result = envelope.result as {
      reflectionHits: Array<{
        reflection: {
          claims: Array<{ text: string }>;
          consequence: string;
          memory: string;
        };
      }>;
    };
    const reflection = result.reflectionHits[0]?.reflection;
    if (reflection === undefined) {
      throw new Error("missing card fixture");
    }
    const consequence = `Fail ${"x".repeat(494)}.`;
    const memory = `M${"y".repeat(698)}.`;
    reflection.consequence = consequence;
    reflection.memory = memory;
    if (reflection.claims[1] !== undefined) reflection.claims[1].text = memory;
    if (reflection.claims[2] !== undefined) {
      reflection.claims[2].text = consequence;
    }
    const port = harness({ stdout: successStdout(envelope) });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneAvailableV1") {
      throw new Error("expected available card lane");
    }
    expect(lane.items[0]?.summary).toContain(consequence);
    expect(lane.items[0]?.summary.length).toBeLessThanOrEqual(1_000);
  });

  test("uses the producer rank rather than array position", async () => {
    const envelope = flowingSuccessEnvelope({ reflectionCount: 0, observationCount: 0 });
    const result = envelope.result as Record<string, unknown>;
    result.reflectionHits = [
      reflectionHitWire({ seed: 1, rank: 1, score: 0.9 }),
      reflectionHitWire({ seed: 2, rank: 2, score: 0.8 }),
    ];
    const port = harness({ stdout: successStdout(envelope) });
    const outcome = await port.run();

    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneAvailableV1") throw new Error("expected an available lane");
    expect(lane.items.map((item) => item.rank)).toEqual([1, 2]);
  });

  test("carries projection health through, snapshot hash included", async () => {
    const port = harness({ stdout: successStdout(flowingSuccessEnvelope()) });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-observations"];
    if (lane._tag !== "RecallLaneAvailableV1") throw new Error("expected an available lane");
    expect(lane.health._tag).toBe("Healthy");
    if (lane.health._tag === "Healthy") {
      expect(lane.health.sourceSnapshotHash).toBe(hex(0xabc));
    }
  });
});

describe("the exit-code and envelope pairing", () => {
  test("exit 3 with an unavailable envelope is the typed unavailable path", async () => {
    const port = harness({
      exitCode: 3,
      stdout: successStdout(
        flowingUnavailableEnvelope("store-unavailable", "projection replica is down"),
      ),
    });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    expect(lane._tag).toBe("RecallLaneUnavailableV1");
    if (lane._tag === "RecallLaneUnavailableV1") {
      expect(lane.code).toBe("store-unavailable");
      expect(lane.message).toBe("flowing recall source unavailable: store-unavailable");
    }
  });

  test("exit 0 with an unavailable envelope is a contract violation", async () => {
    const port = harness({
      exitCode: 0,
      stdout: successStdout(flowingUnavailableEnvelope("store-unavailable", "down")),
    });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("contract-violation");
  });

  test("exit 3 with a success envelope is a contract violation", async () => {
    const port = harness({ exitCode: 3, stdout: successStdout(flowingSuccessEnvelope()) });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("contract-violation");
  });

  test("any other exit code is a process failure", async () => {
    const port = harness({ exitCode: 1, process: { stderr: "boom" } });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("process-failed");
  });
});

describe("envelope defects", () => {
  const rejects = async (mutate: (result: Record<string, any>) => void) => {
    const envelope = flowingSuccessEnvelope();
    mutate(envelope.result as Record<string, any>);
    const port = harness({ stdout: successStdout(envelope) });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") {
      throw new Error("expected the defect to be rejected");
    }
    return lane.code;
  };

  test("rejects hits beyond the echoed limit", async () => {
    expect(
      await rejects((result) => {
        result.query.reflectionLimit = 1;
      }),
    ).toBe("malformed-response");
  });

  test("rejects a non-sequential producer rank instead of renumbering it", async () => {
    expect(
      await rejects((result) => {
        result.reflectionHits[1].rank = 7;
      }),
    ).toBe("malformed-response");
  });

  test("rejects a superseded matched claim with no relation identity", async () => {
    expect(
      await rejects((result) => {
        result.query.includeSuperseded = true;
        result.reflectionHits[0].matchedClaims = [
          { _tag: "Superseded", claimId: `claim:${hex(1)}` },
        ];
      }),
    ).toBe("malformed-response");
  });

  test("rejects a reflection hit with no supporting observations", async () => {
    expect(
      await rejects((result) => {
        result.reflectionHits[0].supportingObservations = [];
      }),
    ).toBe("malformed-response");
  });

  test("rejects supporting observations that do not cover the reflection's sources", async () => {
    expect(
      await rejects((result) => {
        result.reflectionHits[0].reflection.sourceObservationIds = [`observation:v2:${hex(0x999)}`];
      }),
    ).toBe("malformed-response");
  });

  test("rejects a hit with empty evidence", async () => {
    expect(
      await rejects((result) => {
        result.reflectionHits[0].evidence = [];
      }),
    ).toBe("malformed-response");
  });

  test("rejects health with no snapshot hash and rejects reversed health times", async () => {
    expect(
      await rejects((result) => {
        result.health = {
          _tag: "Healthy",
          builtAt: "2026-08-22T00:00:00.000Z",
          freshAt: "2026-08-22T00:05:00.000Z",
        };
      }),
    ).toBe("malformed-response");
    expect(
      await rejects((result) => {
        result.health = {
          _tag: "Healthy",
          builtAt: "2026-08-22T00:05:00.000Z",
          freshAt: "2026-08-22T00:00:00.000Z",
          sourceSnapshotHash: hex(0xabc),
        };
      }),
    ).toBe("malformed-response");
  });

  test("rejects a legacy operational receipt and a legacy hit missing its payload hash", async () => {
    expect(
      await rejects((result) => {
        result.query.legacyLimit = 1;
        const legacy = legacyHitWire(0x40, 1) as Record<string, any>;
        delete legacy.payloadHash;
        result.legacyHits = [legacy];
      }),
    ).toBe("malformed-response");
  });

  test("rejects superseded claims when supersession was not requested", async () => {
    expect(
      await rejects((result) => {
        result.reflectionHits[0].matchedClaims = [
          {
            _tag: "Superseded",
            claimId: `claim:${hex(1)}`,
            relationId: `relation:v1:${hex(2)}`,
            supersedingClaimId: `claim:${hex(3)}`,
            supersedingReflectionId: `reflection:v1:${hex(4)}`,
          },
        ];
      }),
    ).toBe("malformed-response");
  });

  test("reports a foreign schema version as a contract mismatch", async () => {
    const envelope = flowingSuccessEnvelope();
    envelope.schemaVersion = 3;
    const port = harness({ stdout: successStdout(envelope) });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("contract-mismatch");
  });

  test("reports output that is not one JSON document as malformed", async () => {
    const port = harness({ stdout: "not json at all" });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-observations"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("malformed-response");
  });
});

describe("the echoed query must be the query that was sent", () => {
  const rejectsEcho = async (mutate: (query: Record<string, any>) => void) => {
    const request = testRequest();
    const query = flowingQueryWire(request) as Record<string, any>;
    mutate(query);
    const envelope = flowingSuccessEnvelope({ query });
    const port = harness({ stdout: successStdout(envelope) });
    const outcome = await port.run(request);
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected a contract violation");
    return lane.code;
  };

  test("rejects a widened scope", async () => {
    expect(
      await rejectsEcho((query) => {
        query.scope.workstream = "other";
        query.access.scope.workstream = "other";
      }),
    ).toBe("contract-violation");
  });

  test("rejects a relaxed privacy grant", async () => {
    expect(
      await rejectsEcho((query) => {
        query.access.allowedPrivacy = ["private", "sensitive"];
      }),
    ).toBe("contract-violation");
  });

  test("rejects a changed principal, purpose, or decision time", async () => {
    expect(
      await rejectsEcho((query) => {
        query.access.principalRef = "operator:someone-else";
      }),
    ).toBe("contract-violation");
    expect(
      await rejectsEcho((query) => {
        query.access.purpose = "something-else";
      }),
    ).toBe("contract-violation");
    expect(
      await rejectsEcho((query) => {
        query.access.decidedAt = "2026-01-01T00:00:00.000Z";
      }),
    ).toBe("contract-violation");
  });

  test("rejects a changed question and a raised legacy limit", async () => {
    expect(
      await rejectsEcho((query) => {
        query.text = "a different question";
      }),
    ).toBe("contract-violation");
    expect(
      await rejectsEcho((query) => {
        query.legacyLimit = 5;
      }),
    ).toBe("contract-violation");
  });
});

describe("scope and privacy of returned records", () => {
  test("rejects a record outside the requested scope", async () => {
    const envelope = flowingSuccessEnvelope({
      reflectionCount: 0,
      observationCount: 0,
    });
    (envelope.result as Record<string, any>).observationHits = [
      observationHitWire({
        seed: 0x20,
        rank: 1,
        scope: { project: "joelhooks.other", workstream: "main" },
      }),
    ];
    const port = harness({ stdout: successStdout(envelope) });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-observations"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected a contract violation");
    expect(lane.code).toBe("contract-violation");
  });

  test("rejects evidence outside the granted privacy tiers", async () => {
    const envelope = flowingSuccessEnvelope({ evidencePrivacy: "sensitive" });
    const port = harness({ stdout: successStdout(envelope) });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected a contract violation");
    expect(lane.code).toBe("contract-violation");
  });

  test("rejects a record whose privacy is outside the grant", async () => {
    const envelope = flowingSuccessEnvelope({ privacy: "sensitive" });
    const port = harness({ stdout: successStdout(envelope) });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected a contract violation");
    expect(lane.code).toBe("contract-violation");
  });
});

describe("failure modes", () => {
  test("a timeout is typed, and no lane pretends to have answered", async () => {
    const port = harness({ process: { timedOut: true, exitCode: 124 } });
    const outcome = await port.run();
    for (const lane of ["flowing-reflections", "flowing-observations"] as const) {
      const value = outcome.lanes[lane];
      if (value._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
      expect(value.code).toBe("timeout");
    }
  });

  test("a credential that cannot be leased stops the read before it starts", async () => {
    const seen: BoundaryProcessRequest[] = [];
    const outcome = await readFlowingRecall({
      request: testRequest(),
      config: TEST_FLOWING_CONFIG,
      parentEnv: {},
      leaseCredential: async () => ({ ok: false, message: "credential lease exited 4" }),
      runProcess: async (request) => {
        seen.push(request);
        return okProcess();
      },
    });

    expect(seen).toHaveLength(0);
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("credential-unavailable");
  });

  test("child diagnostics never appear in a lane message", async () => {
    const query = testRequest().text;
    const port = harness({
      exitCode: 1,
      process: { stderr: `connection to ${TEST_SECRET} refused while reading ${query}` },
    });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.message).toBe("flowing recall read exited 1");
    expect(lane.message).not.toContain(TEST_SECRET);
    expect(lane.message).not.toContain(query);
  });

  test("thrown process errors never echo the query", async () => {
    const query = testRequest().text;
    const outcome = await readFlowingRecall({
      request: testRequest(),
      config: TEST_FLOWING_CONFIG,
      parentEnv: {},
      leaseCredential: async () => ({ ok: true, value: TEST_SECRET }),
      runProcess: async () => {
        throw new Error(`failed to process ${query}`);
      },
    });
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.message).toBe("flowing recall read process failed");
    expect(lane.message).not.toContain(query);
  });

  test("an unscoped request is refused without touching the boundary", async () => {
    const seen: BoundaryProcessRequest[] = [];
    const outcome = await readFlowingRecall({
      request: testRequest({ scope: { _tag: "ProjectWorkstream", project: "", workstream: "" } }),
      config: TEST_FLOWING_CONFIG,
      parentEnv: {},
      leaseCredential: async () => ({ ok: true, value: TEST_SECRET }),
      runProcess: async (request) => {
        seen.push(request);
        return okProcess();
      },
    });

    expect(seen).toHaveLength(0);
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("invalid-input");
  });
});

describe("the wire mirror enforces the pinned identity patterns", () => {
  const rejects = async (mutate: (result: Record<string, any>) => void) => {
    const envelope = flowingSuccessEnvelope();
    mutate(envelope.result as Record<string, any>);
    const port = harness({ stdout: successStdout(envelope) });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") {
      throw new Error("expected the defect to be rejected");
    }
    return lane.code;
  };

  test("rejects a failed projection whose receipt ID is not canonical", async () => {
    expect(
      await rejects((result) => {
        result.health = { _tag: "Failed", failureReceiptId: "not-a-canonical-failure-id" };
      }),
    ).toBe("malformed-response");
  });

  test.each([
    ["canonical", `failure:${hex(0x51)}`],
    ["bare source wake receipt", hex(0x51)],
  ])(
    "accepts a %s failure receipt and carries a canonical ID into lane health",
    async (_, receipt) => {
      const port = harness({
        stdout: successStdout(
          flowingSuccessEnvelope({
            health: {
              _tag: "Failed",
              failureReceiptId: receipt,
              lastValidSnapshotHash: hex(0x52),
            },
          }),
        ),
      });
      const outcome = await port.run();
      const lane = outcome.lanes["flowing-reflections"];
      if (lane._tag !== "RecallLaneAvailableV1" || lane.health._tag !== "Failed") {
        throw new Error("expected a failed available flowing lane");
      }
      expect(lane.health.failureReceiptId).toBe(`failure:${hex(0x51)}`);
      expect(lane.health.lastValidSnapshotHash).toBe(hex(0x52));
    },
  );

  test("preserves build and freshness times on a stale projection", async () => {
    const port = harness({
      stdout: successStdout(
        flowingSuccessEnvelope({
          health: {
            _tag: "Stale",
            builtAt: "2026-08-20T00:00:00.000Z",
            freshAt: "2026-08-21T00:00:00.000Z",
            sourceSnapshotHash: hex(0x53),
            staleSince: "2026-08-22T00:00:00.000Z",
          },
        }),
      ),
    });
    const outcome = await port.run();
    const lane = outcome.lanes["flowing-observations"];
    if (lane._tag !== "RecallLaneAvailableV1" || lane.health._tag !== "Stale") {
      throw new Error("expected a stale available flowing lane");
    }
    expect(lane.health.builtAt).toBe("2026-08-20T00:00:00.000Z");
    expect(lane.health.freshAt).toBe("2026-08-21T00:00:00.000Z");
    expect(lane.health.staleSince).toBe("2026-08-22T00:00:00.000Z");
  });

  test("rejects a credential-shaped or path-shaped runtime capture identifier", async () => {
    expect(
      await rejects((result) => {
        result.reflectionHits[0].evidence[0].runId = "run.secret.value";
      }),
    ).toBe("malformed-response");
    expect(
      await rejects((result) => {
        result.reflectionHits[0].evidence[0].conversationId = "../../etc/passwd";
      }),
    ).toBe("malformed-response");
    expect(
      await rejects((result) => {
        result.reflectionHits[0].evidence[0].runId = "ghp_deadbeefdeadbeefdeadbeef";
      }),
    ).toBe("malformed-response");
  });
});

describe("the release is re-proved immediately before the credential is leased", () => {
  test("an artifact swapped after resolution neither runs nor leases", async () => {
    const release = testRelease();
    const resolved = resolveFlowingRecallPortConfig({
      settings: {
        read_executable: release.executable,
        credential_secret_name: "flowing-runtime-url",
      },
      ...testReleaseSeams(release),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Verification happened. Now the file changes underneath the binding, the
    // way anyone who can write the release directory would change it.
    chmodSync(release.executable, 0o700);
    writeFileSync(release.executable, "#!/bin/sh\necho pwned\n");
    chmodSync(release.executable, 0o555);

    let leaseCalls = 0;
    let processCalls = 0;
    const outcome = await readFlowingRecall({
      request: testRequest(),
      config: resolved.config,
      parentEnv: {},
      leaseCredential: async () => {
        leaseCalls += 1;
        return { ok: true, value: TEST_SECRET };
      },
      runProcess: async () => {
        processCalls += 1;
        throw new Error("the swapped artifact must never be executed");
      },
    });

    expect(leaseCalls).toBe(0);
    expect(processCalls).toBe(0);
    for (const laneName of ["flowing-reflections", "flowing-observations"] as const) {
      const lane = outcome.lanes[laneName];
      if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
      expect(lane.code).toBe("untrusted-executable");
    }
  });

  test("a release made writable after resolution neither runs nor leases", async () => {
    const release = testRelease();
    const resolved = resolveFlowingRecallPortConfig({
      settings: {
        read_executable: release.executable,
        credential_secret_name: "flowing-runtime-url",
      },
      ...testReleaseSeams(release),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    chmodSync(release.executable, 0o755);

    let leaseCalls = 0;
    const outcome = await readFlowingRecall({
      request: testRequest(),
      config: resolved.config,
      parentEnv: {},
      leaseCredential: async () => {
        leaseCalls += 1;
        return { ok: true, value: TEST_SECRET };
      },
      runProcess: async () => {
        throw new Error("a writable artifact must never be executed");
      },
    });

    expect(leaseCalls).toBe(0);
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("untrusted-executable");
  });
});

describe("the release is re-proved again after the credential is leased", () => {
  function resolvedFor(release: ReturnType<typeof testRelease>) {
    const resolved = resolveFlowingRecallPortConfig({
      settings: {
        read_executable: release.executable,
        credential_secret_name: "flowing-runtime-url",
      },
      ...testReleaseSeams(release),
    });
    if (!resolved.ok) throw new Error(`fixture release did not resolve: ${resolved.message}`);
    return resolved.config;
  }

  test("an artifact swapped during the lease neither spawns nor reaches a child", async () => {
    // The lease is a round trip to another process. This fake is the attacker
    // winning that window: the swap happens while the credential is in flight,
    // so the pre-lease proof already passed and a secret now exists.
    const release = testRelease();
    const config = resolvedFor(release);

    let processCalls = 0;
    const outcome = await readFlowingRecall({
      request: testRequest(),
      config,
      parentEnv: {},
      leaseCredential: async () => {
        chmodSync(release.executable, 0o700);
        writeFileSync(release.executable, "#!/bin/sh\ncat /proc/self/environ\n");
        chmodSync(release.executable, 0o555);
        return { ok: true, value: TEST_SECRET };
      },
      runProcess: async () => {
        processCalls += 1;
        throw new Error("an artifact swapped during the lease must never be executed");
      },
    });

    expect(processCalls).toBe(0);
    for (const laneName of ["flowing-reflections", "flowing-observations"] as const) {
      const lane = outcome.lanes[laneName];
      if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
      expect(lane.code).toBe("untrusted-executable");
      expect(lane.message).not.toContain(TEST_SECRET);
    }
  });

  test("an artifact replaced during the lease by an identical rebuild is refused", async () => {
    // Same bytes, same mode, same path, new inode. Digest and mode both agree;
    // only identity says this is not the file that was verified.
    const release = testRelease();
    const config = resolvedFor(release);
    const body = readFileSync(release.executable);

    let processCalls = 0;
    const outcome = await readFlowingRecall({
      request: testRequest(),
      config,
      parentEnv: {},
      leaseCredential: async () => {
        withUnsealedRelease(release.releaseDir, () => {
          rmSync(release.executable);
          writeFileSync(release.executable, body);
          chmodSync(release.executable, 0o555);
        });
        return { ok: true, value: TEST_SECRET };
      },
      runProcess: async () => {
        processCalls += 1;
        throw new Error("a replaced artifact must never be executed");
      },
    });

    expect(sha256Of(release.executable)).toBe(config.release.sha256);
    expect(processCalls).toBe(0);
    const lane = outcome.lanes["flowing-reflections"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("untrusted-executable");
  });

  test("a release directory made writable during the lease is refused", async () => {
    const release = testRelease();
    const config = resolvedFor(release);

    let processCalls = 0;
    const outcome = await readFlowingRecall({
      request: testRequest(),
      config,
      parentEnv: {},
      leaseCredential: async () => {
        chmodSync(release.releaseDir, 0o755);
        return { ok: true, value: TEST_SECRET };
      },
      runProcess: async () => {
        processCalls += 1;
        throw new Error("a writable release directory must never be executed from");
      },
    });

    expect(processCalls).toBe(0);
    const lane = outcome.lanes["flowing-observations"];
    if (lane._tag !== "RecallLaneUnavailableV1") throw new Error("expected unavailable");
    expect(lane.code).toBe("untrusted-executable");
  });

  test("an untouched release still leases, spawns, and answers", async () => {
    // The negative controls above are only meaningful if the same shape passes.
    const release = testRelease();
    const config = resolvedFor(release);

    let processCalls = 0;
    const outcome = await readFlowingRecall({
      request: testRequest(),
      config,
      parentEnv: {},
      leaseCredential: async () => ({ ok: true, value: TEST_SECRET }),
      runProcess: async () => {
        processCalls += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify(flowingSuccessEnvelope()),
          stderr: "",
          timedOut: false,
          missingExecutable: false,
        };
      },
    });

    expect(processCalls).toBe(1);
    expect(outcome.lanes["flowing-reflections"]._tag).toBe("RecallLaneAvailableV1");
  });
});
