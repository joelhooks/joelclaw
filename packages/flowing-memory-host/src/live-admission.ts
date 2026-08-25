import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";

import { resolveRepositoryScope } from "@joelclaw/recall";
import {
  PostgresAdmissionLedger,
  PostgresAdmissionLedgerLive,
  PostgresRuntimeClientLive,
} from "@joelclaw-memory/postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { TrustedAdmissionConfigV1 } from "./admission-builder.js";
import type { NativeAdmissionInputV1 } from "./collector.js";
import { type AdmissionLedgerClient, makeTrustedNativeAdmissionPort } from "./trusted-admission.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const baseConfig = {
  adapterInstanceIdHash: hash(`flowing-memory-host:${hostname()}`),
  principalIdHash: hash(`flowing-memory-principal:${userInfo().uid}`),
};

const fallbackConfig = (
  reason: "no-repository" | "untrusted-repository",
): TrustedAdmissionConfigV1 => ({
  ...baseConfig,
  canonicalRepository: "github.com/joelclaw/fleet",
  privacy: reason === "no-repository" ? "private" : "sensitive",
  project: "joelclaw-fleet",
  projection: reason === "no-repository" ? "enabled" : "disabled",
  repositoryHost: "github.com",
  repositoryName: "fleet",
  repositoryOwner: "joelclaw",
  scopeFallbackReason: reason,
  scopeResolution: "fleetFallback",
  workstream: "default",
});

const repositoryPolicy = async (root: string) => {
  try {
    const value = JSON.parse(await readFile(path.join(root, ".flowing-memory.json"), "utf8")) as {
      readonly privacy?: unknown;
      readonly projection?: unknown;
    };
    const privacy = value.privacy === "private" ? "private" : "sensitive";
    const projection =
      privacy === "sensitive" || value.projection !== "enabled" ? "disabled" : "enabled";
    return { privacy, projection } as const;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { privacy: "private", projection: "enabled" } as const;
    }
    return { privacy: "sensitive", projection: "disabled" } as const;
  }
};

export const resolveTrustedAdmissionConfig = async (
  input: NativeAdmissionInputV1,
): Promise<TrustedAdmissionConfigV1 | undefined> => {
  const cwd = input.wake.cwd;
  if (cwd === undefined) return fallbackConfig("no-repository");
  if (!path.isAbsolute(cwd)) return fallbackConfig("untrusted-repository");
  const resolution = await resolveRepositoryScope({ cwd });
  if (resolution._tag === "TransientFailure") return undefined;
  if (resolution._tag === "NoRepository") return fallbackConfig("no-repository");
  if (resolution._tag === "UntrustedRepository") {
    return fallbackConfig("untrusted-repository");
  }

  const policy = await repositoryPolicy(resolution.repositoryRoot);
  return {
    ...baseConfig,
    canonicalRepository: resolution.canonicalRepository,
    project: resolution.project,
    repositoryHost: resolution.repositoryHost,
    repositoryName: resolution.repositoryName,
    repositoryOwner: resolution.repositoryOwner,
    ...policy,
    scopeResolution: "repository",
    workstream: resolution.scope.workstream,
  };
};

const ledgerRuntime = ManagedRuntime.make(
  PostgresAdmissionLedgerLive.pipe(Layer.provide(PostgresRuntimeClientLive)),
);
const ledger: AdmissionLedgerClient = {
  admit: (command) =>
    ledgerRuntime.runPromise(
      Effect.flatMap(PostgresAdmissionLedger, (service) => service.admit(command)),
    ),
};

export const admission = makeTrustedNativeAdmissionPort({
  config: resolveTrustedAdmissionConfig,
  evidenceDirectory:
    process.env.JOELCLAW_MEMORY_EVIDENCE_DIRECTORY ??
    path.join(homedir(), ".joelclaw", "flowing-memory", "evidence"),
  ledger,
});

export default admission;
