import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  PostgresAdmissionLedger,
  PostgresAdmissionLedgerLive,
  PostgresRuntimeClientLive,
} from "@joelclaw-memory/postgres";
import { Effect, Layer, ManagedRuntime } from "effect";

import type { NativeAdmissionInputV1 } from "./collector.js";
import { makeTrustedNativeAdmissionPort, type AdmissionLedgerClient } from "./trusted-admission.js";
import type { TrustedAdmissionConfigV1 } from "./admission-builder.js";

const execFilePromise = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const scopeKey = (value: string, fallback: string) => {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._/-]+/gu, "-")
    .replaceAll(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "")
    .slice(0, 240);
  return normalized.length === 0 ? fallback : normalized;
};

type GitResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly transient: boolean };

const git = async (cwd: string, ...arguments_: readonly string[]): Promise<GitResult> => {
  try {
    const result = await execFilePromise("git", ["-C", cwd, ...arguments_], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return { ok: true, value: result.stdout.trim() };
  } catch (error) {
    const details = error as { readonly code?: number | string; readonly killed?: boolean };
    return {
      ok: false,
      transient: details.killed === true || details.code === "ETIMEDOUT",
    };
  }
};

const githubIdentity = (remote: string) => {
  const match = remote.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/iu,
  );
  if (match === null) return undefined;
  const owner = scopeKey(match[1] ?? "", "unknown");
  const name = scopeKey(match[2] ?? "", "unknown");
  return {
    canonicalRepository: `github.com/${owner}/${name}`,
    project: `${owner}.${name}`,
    repositoryHost: "github.com",
    repositoryName: name,
    repositoryOwner: owner,
  } as const;
};

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
  if (cwd === undefined || !path.isAbsolute(cwd)) return undefined;
  const rootResult = await git(cwd, "rev-parse", "--show-toplevel");
  if (!rootResult.ok) {
    return rootResult.transient ? undefined : fallbackConfig("no-repository");
  }
  const remoteResult = await git(rootResult.value, "remote", "get-url", "origin");
  if (!remoteResult.ok) {
    return remoteResult.transient ? undefined : fallbackConfig("untrusted-repository");
  }
  const identity = githubIdentity(remoteResult.value);
  if (identity === undefined) return fallbackConfig("untrusted-repository");
  const branchResult = await git(rootResult.value, "symbolic-ref", "--quiet", "--short", "HEAD");
  const policy = await repositoryPolicy(rootResult.value);
  return {
    ...baseConfig,
    ...identity,
    ...policy,
    scopeResolution: "repository",
    workstream: scopeKey(branchResult.ok ? branchResult.value : "default", "default"),
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
