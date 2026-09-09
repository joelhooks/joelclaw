#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";

import { Config, Effect, Redacted, Schema } from "effect";

import { assessRecord, ForwarderPolicySchema } from "./domain.js";
import { ExecutorSupermemoryAdapter, McpExecutorTransport } from "./executor-client.js";
import { SupermemoryForwarder } from "./forwarder.js";
import { PostgresFlowingMemorySource } from "./source.js";
import { ForwarderStateStore } from "./state-store.js";
import { OtelHttpTelemetry } from "./telemetry.js";

const runtimeConfig = Effect.gen(function* loadRuntimeConfig() {
  return {
    canaryReviewPath: yield* Config.option(
      Config.string("JOELCLAW_SUPERMEMORY_FORWARDER_CANARY_REVIEW_PATH"),
    ),
    databaseUrl: Redacted.value(yield* Config.redacted("JOELCLAW_MEMORY_RUNTIME_DATABASE_URL")),
    otelToken: yield* Config.option(Config.string("OTEL_EMIT_TOKEN")),
    otelUrl: yield* Config.string("JOELCLAW_OTEL_INGEST_URL").pipe(
      Config.withDefault("http://127.0.0.1:3111/observability/emit"),
    ),
    policyPath: yield* Config.string("JOELCLAW_SUPERMEMORY_FORWARDER_POLICY"),
    statePath: yield* Config.string("JOELCLAW_SUPERMEMORY_FORWARDER_STATE"),
  };
});

const main = async (): Promise<void> => {
  const command = process.argv[2];
  if (
    !command ||
    ![
      "daemon",
      "doctor",
      "dry-run",
      "eligibility",
      "init-boundary",
      "prepare-canary",
      "queue-canary",
      "run-canary",
      "run-once",
      "status",
    ].includes(command)
  ) {
    throw new Error(
      "usage: flowing-memory-supermemory-forwarder <init-boundary|doctor|eligibility|dry-run|prepare-canary|queue-canary|run-canary|run-once|daemon|status>",
    );
  }

  const config = await Effect.runPromise(runtimeConfig);
  const policy = Schema.decodeUnknownSync(ForwarderPolicySchema)(
    JSON.parse(await readFile(config.policyPath, "utf8")) as unknown,
  );
  const state = new ForwarderStateStore(config.statePath);
  if (command === "status") {
    console.log(
      JSON.stringify({
        ok: true,
        boundary: state.boundary(),
        seenCommitCount: state.seenCommitIds().length,
        deliveries: state.counts(),
        excluded: state.excludedCounts(),
        authorityModel: {
          projectionCommits: "included",
          reviewedCards: "excluded-v1",
          reviewedCardWithdrawals: "excluded-v1",
        },
      }),
    );
    state.close();
    return;
  }

  const source = new PostgresFlowingMemorySource(config.databaseUrl);
  const remote = new ExecutorSupermemoryAdapter(
    new McpExecutorTransport(policy.executorUrl),
    policy.containerTag,
    policy.supermemoryConnection,
  );
  const telemetry = new OtelHttpTelemetry(
    config.otelUrl,
    config.otelToken._tag === "Some" ? config.otelToken.value : undefined,
  );
  const forwarder = new SupermemoryForwarder({ policy, remote, source, state, telemetry });

  try {
    if (command === "init-boundary") {
      console.log(JSON.stringify({ ok: true, boundary: await forwarder.initializeBoundary() }));
      return;
    }
    if (command === "doctor") {
      await remote.verifySpace();
      console.log(JSON.stringify({ ok: true, containerTag: policy.containerTag }));
      return;
    }
    if (command === "eligibility") {
      console.log(JSON.stringify({ ok: true, counts: await source.eligibilityCounts(policy) }));
      return;
    }
    if (command === "dry-run") {
      console.log(JSON.stringify({ ok: true, receipt: await forwarder.dryRun() }));
      return;
    }
    if (command === "prepare-canary" || command === "queue-canary") {
      if (state.boundary() === null) throw new Error("initialize the no-history boundary first");
      if (policy.canaryRecordId === undefined) throw new Error("policy has no canary record ID");
      const records = await source.activeCommittedRecords([policy.canaryRecordId]);
      const canaryRecord = records[0];
      if (records.length !== 1 || canaryRecord === undefined) {
        throw new Error("canary record is not uniquely current and committed");
      }
      const assessment = assessRecord(canaryRecord, policy);
      if (assessment._tag === "Excluded") throw new Error("canary record is not export eligible");
      if (command === "prepare-canary") {
        if (config.canaryReviewPath._tag === "None") throw new Error("canary review path is missing");
        const reviewPath = config.canaryReviewPath.value;
        await writeFile(
          reviewPath,
          `${JSON.stringify(
            {
              commitId: assessment.memory.commitId,
              payload: assessment.memory.payload,
              payloadHash: assessment.memory.payloadHash,
              privacy: assessment.memory.privacy,
              recordId: assessment.memory.recordId,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
        await chmod(reviewPath, 0o600);
        console.log(JSON.stringify({ ok: true, payloadHash: assessment.memory.payloadHash }));
        return;
      }
      if (state.deliveryStatus(`save:${assessment.memory.recordId}`) !== null) {
        throw new Error("canary is already present in the delivery ledger");
      }
      state.ingest(
        [assessment],
        [
          {
            commitCreatedAt: assessment.memory.commitCreatedAt,
            commitId: assessment.memory.commitId,
          },
        ],
      );
      console.log(JSON.stringify({ ok: true, queued: 1, payloadHash: assessment.memory.payloadHash }));
      return;
    }
    if (state.boundary() === null) {
      throw new Error("activation boundary missing; run init-boundary first");
    }
    if (command === "run-canary") {
      if (policy.canaryRecordId === undefined) throw new Error("policy has no canary record ID");
      console.log(
        JSON.stringify({
          ok: true,
          outcome: await forwarder.runCanary(policy.canaryRecordId),
        }),
      );
      return;
    }
    if (command === "run-once") {
      console.log(JSON.stringify({ ok: true, receipt: await forwarder.runPass() }));
      return;
    }

    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    while (!stopping) {
      try {
        const receipt = await forwarder.runPass();
        console.log(JSON.stringify({ ok: true, receipt }));
      } catch {
        console.error(JSON.stringify({ ok: false, error: "forwarder-pass-failed" }));
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, policy.pollIntervalMs));
    }
  } finally {
    await source.close();
    state.close();
  }
};

main().catch(() => {
  console.error(JSON.stringify({ ok: false, error: "forwarder-command-failed" }));
  process.exitCode = 1;
});
