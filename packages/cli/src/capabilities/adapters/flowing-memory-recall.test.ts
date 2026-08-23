/**
 * Registered composed recall adapter.
 *
 * These tests exercise the adapter that is actually registered, through real
 * capability config resolution, with fake process boundaries.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  curatedSearchResult,
  flowingSuccessEnvelope,
  TEST_SECRET,
  testRelease,
} from "../../recall/test-fixtures";
import { DEFAULT_CAPABILITY_CONFIG, resolveCapabilitiesConfig } from "../config";
import { capabilityRegistry } from "../setup";
import {
  __flowingMemoryRecallTestUtils,
  createFlowingMemoryRecallAdapter,
  FLOWING_MEMORY_RECALL_ADAPTER,
  flowingMemoryRecallAdapter,
} from "./flowing-memory-recall";

const queryArgs = {
  allowedPrivacy: ["private"] as const,
  curatedLimit: 5,
  decidedAt: "2026-08-22T00:00:00.000Z",
  includeSuperseded: false,
  observationLimit: 5,
  principalRef: "operator:joel",
  project: "joelhooks.joelclaw-memory",
  purpose: "recall-adapter-comparison",
  query: "postgres search index",
  reflectionLimit: 5,
  workstream: "main",
};

function projectConfig(settings: Record<string, string>): { cwd: string; configPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "recall-project-"));
  mkdirSync(join(cwd, ".joelclaw"), { recursive: true });
  const lines = Object.entries(settings).map(([key, value]) => `${key} = "${value}"`);
  const configPath = join(cwd, ".joelclaw", "config.toml");
  writeFileSync(
    configPath,
    `[capabilities.recall.adapters.flowing-memory-recall]\n${lines.join("\n")}\n`,
  );
  return { cwd, configPath };
}

function trustedExecutable(): { root: string; executable: string; sha256: string } {
  const release = testRelease();
  return { root: release.root, executable: release.executable, sha256: release.sha256 };
}

function contextFor(cwd: string) {
  return {
    cwd,
    now: new Date("2026-08-22T12:00:00.000Z"),
    config: resolveCapabilitiesConfig({ cwd, env: {} }),
  };
}

describe("the default recall binding", () => {
  test("uses the composed adapter and keeps the old adapter registered for rollback", () => {
    expect(DEFAULT_CAPABILITY_CONFIG.recall?.adapter).toBe(FLOWING_MEMORY_RECALL_ADAPTER);
    expect(capabilityRegistry.get("recall", FLOWING_MEMORY_RECALL_ADAPTER)).toBe(
      flowingMemoryRecallAdapter,
    );
    expect(capabilityRegistry.adaptersFor("recall")).toContain(FLOWING_MEMORY_RECALL_ADAPTER);
    expect(capabilityRegistry.adaptersFor("recall")).toContain("typesense-recall");
    const resolved = resolveCapabilitiesConfig({ cwd: mkdtempSync(join(tmpdir(), "x-")), env: {} });
    expect(resolved.capabilities.recall?.adapter).toBe(FLOWING_MEMORY_RECALL_ADAPTER);
  });
});

describe("adapter arguments", () => {
  test("carry no legacy limit and no retired recall vocabulary", () => {
    const request = __flowingMemoryRecallTestUtils.buildComposedRequest(queryArgs);
    expect(Object.keys(request.limits).sort()).toEqual([
      "curated",
      "observations",
      "reflections",
    ]);
    const fields = Object.keys(__flowingMemoryRecallTestUtils.commands.query.argsSchema.fields);
    expect(fields).not.toContain("legacyLimit");
    for (const retired of ["budget", "category", "includeHold", "includeDiscard", "minScore"]) {
      expect(fields).not.toContain(retired);
    }
  });
});

describe("configured settings reach the registered adapter", () => {
  test("an executable outside the trusted release root is refused, and nothing spawns", async () => {
    const outside = mkdtempSync(join(tmpdir(), "flowing-elsewhere-"));
    const executable = join(outside, "joelclaw-memory");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    const { cwd } = projectConfig({
      read_executable: executable,
      credential_secret_name: "flowing-runtime-url",
    });

    const previousDb = process.env.JOELCLAW_CRITICAL_DB;
    process.env.JOELCLAW_CRITICAL_DB = join(outside, "no-such-critical.db");
    try {
      const port = capabilityRegistry.get("recall", FLOWING_MEMORY_RECALL_ADAPTER);
      if (!port) throw new Error("expected the adapter to be registered");
      const result = (await Effect.runPromise(
        port.execute("query", queryArgs, contextFor(cwd)),
      )) as { payload: { composed: { lanes: Record<string, { code?: string }> } } };

      expect(result.payload.composed.lanes.flowingReflections?.code).toBe("untrusted-executable");
      // The curated lane could not reach a database either. No lane invented an answer.
      expect(result.payload.composed.lanes.curatedPages?.code).toBe("store-unavailable");
    } finally {
      if (previousDb === undefined) delete process.env.JOELCLAW_CRITICAL_DB;
      else process.env.JOELCLAW_CRITICAL_DB = previousDb;
    }
  });

  test("the configured secret name is what the credential lease is asked for", async () => {
    const { root, executable, sha256 } = trustedExecutable();
    const { cwd } = projectConfig({
      read_executable: executable,
      credential_secret_name: "configured-secret-name",
    });

    let leasedName: string | undefined;
    const adapter = createFlowingMemoryRecallAdapter({
      trustedReleaseRoot: root,
      expectedArtifactSha256: sha256,
      leaseCredential: async (leaseRequest) => {
        leasedName = leaseRequest.secretName;
        return { ok: false, message: "credential lease exited 4" };
      },
      curatedSearch: () => curatedSearchResult([]),
      parentEnv: {},
    });

    const result = (await Effect.runPromise(
      adapter.execute("query", queryArgs, contextFor(cwd)),
    )) as { payload: { composed: { lanes: Record<string, { code?: string }> } } };

    expect(leasedName).toBe("configured-secret-name");
    expect(result.payload.composed.lanes.flowingObservations?.code).toBe("credential-unavailable");
  });

  test("the configured executable is what the read boundary runs, with adapter-owned arguments", async () => {
    const { root, executable, sha256 } = trustedExecutable();
    const { cwd } = projectConfig({
      read_executable: executable,
      credential_secret_name: "flowing-runtime-url",
    });

    let command: readonly string[] = [];
    const adapter = createFlowingMemoryRecallAdapter({
      trustedReleaseRoot: root,
      expectedArtifactSha256: sha256,
      leaseCredential: async () => ({ ok: true, value: TEST_SECRET }),
      runProcess: async (processRequest) => {
        command = processRequest.command;
        return {
          exitCode: 0,
          stdout: JSON.stringify(flowingSuccessEnvelope()),
          stderr: "",
          timedOut: false,
          missingExecutable: false,
        };
      },
      curatedSearch: () => curatedSearchResult([{ id: "brain-1" }]),
      parentEnv: { PATH: "/usr/bin" },
    });

    const result = (await Effect.runPromise(
      adapter.execute("query", queryArgs, contextFor(cwd)),
    )) as {
      payload: { composed: { lanes: Record<string, { items?: unknown[] }> } };
    };

    expect(command).toEqual([
      realpathSync(executable),
      "flowing-recall-read",
      "--query-file",
      "-",
    ]);
    expect(result.payload.composed.lanes.flowingReflections?.items).toHaveLength(2);
    expect(result.payload.composed.lanes.curatedPages?.items).toHaveLength(1);
  });

  test("refuses an unscoped request before touching any boundary", async () => {
    let spawned = false;
    const adapter = createFlowingMemoryRecallAdapter({
      runProcess: async () => {
        spawned = true;
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, missingExecutable: false };
      },
      curatedSearch: () => curatedSearchResult([]),
    });

    const outcome = await Effect.runPromiseExit(
      adapter.execute(
        "query",
        { ...queryArgs, project: "", workstream: "" },
        contextFor(mkdtempSync(join(tmpdir(), "recall-unscoped-"))),
      ),
    );

    expect(outcome._tag).toBe("Failure");
    expect(spawned).toBe(false);
  });

  test("emits lane telemetry without query or access bodies", async () => {
    const { root, executable, sha256 } = trustedExecutable();
    const { cwd } = projectConfig({
      read_executable: executable,
      credential_secret_name: "flowing-runtime-url",
    });
    const events: Array<{ action: string; metadata: Record<string, unknown> }> = [];
    const adapter = createFlowingMemoryRecallAdapter({
      trustedReleaseRoot: root,
      expectedArtifactSha256: sha256,
      leaseCredential: async () => ({ ok: true, value: TEST_SECRET }),
      runProcess: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(flowingSuccessEnvelope()),
        stderr: "",
        timedOut: false,
        missingExecutable: false,
      }),
      curatedSearch: () => curatedSearchResult([{ id: "brain-1" }]),
      parentEnv: { PATH: "/usr/bin" },
      emitTelemetry: async (event) => {
        events.push({ action: event.action, metadata: event.metadata });
      },
    });

    await Effect.runPromise(adapter.execute("query", queryArgs, contextFor(cwd)));
    expect(events.map((event) => event.action)).toEqual([
      "memory.recall.started",
      "memory.recall.completed",
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(queryArgs.query);
    expect(serialized).not.toContain(queryArgs.principalRef);
    expect(serialized).not.toContain(queryArgs.purpose);
    expect(serialized).toContain("scopeHash");
    expect(serialized).toContain("principalClass");
    expect(serialized).toContain("laneName");
    expect(serialized).toContain("healthStatus");
    expect(serialized).toContain("itemCount");
    expect(serialized).toContain("source");
  });
});
