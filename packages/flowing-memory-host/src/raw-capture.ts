import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  type NativeRuntime,
  type NativeWakeV1,
  verifyNativeSource,
} from "./adapters.js";

export type RawCaptureRuntime = "pi" | "claude-code" | "codex" | "cursor" | "grok";

export type RawCaptureResult =
  | { readonly status: "accepted"; readonly runId: string; readonly toOffset: number }
  | { readonly status: "noop"; readonly reason: "event" | "empty" | "no-new-bytes" }
  | {
      readonly status: "degraded";
      readonly code:
        | "auth-invalid"
        | "capture-url-invalid"
        | "network-failed"
        | "response-invalid"
        | "source-unavailable"
        | "source-untrusted"
        | "source-shrank"
        | "state-write-failed";
    };

export interface RawCaptureDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly home?: string;
  readonly httpTimeoutMs?: number;
  readonly now?: () => number;
  readonly runId?: () => string;
  readonly verifySource?: (wake: NativeWakeV1) => Promise<void>;
}

interface CaptureAuth {
  readonly machine_id: string;
  readonly token: string;
  readonly user_id: string;
}

interface CaptureState {
  readonly source_identity: string;
  readonly last_byte_offset: number;
  readonly last_captured_at: string;
  readonly last_run_id: string | null;
}

interface CaptureResponse {
  readonly run_id?: unknown;
  readonly status?: unknown;
  readonly to_offset?: unknown;
}

const strictAcceptedOffset = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

interface PendingCaptureEnvelope {
  readonly schema_version: 1;
  readonly state_key: string;
  readonly wake: NativeWakeV1;
  readonly body: Record<string, unknown>;
}

export interface RawCaptureReplayReceipt {
  readonly accepted: number;
  readonly attempted: number;
  readonly failed: number;
  readonly invalid: number;
  readonly stale: number;
}

const DEFAULT_HTTP_TIMEOUT_MS = 750;
// Cursor and Grok have canonical native-store sweep readers. Their flowing
// hooks stay wake-only so normalized sweep bytes cannot race raw hook bytes.
const RAW_HOOK_CAPTURE_RUNTIMES = new Set<NativeRuntime>(["pi", "claude", "codex"]);
const captureWorkers = new Map<
  string,
  {
    pending: { wake: NativeWakeV1; dependencies: RawCaptureDependencies } | undefined;
    running: Promise<void>;
  }
>();

const rawRuntime = (runtime: NativeRuntime): RawCaptureRuntime =>
  runtime === "claude" ? "claude-code" : runtime;

const captureEvents = {
  pi: new Set(["turn_end", "session_shutdown"]),
  claude: new Set(["Stop", "StopFailure", "SessionEnd"]),
  codex: new Set(["Stop", "SessionEnd"]),
  cursor: new Set(["afterAgentResponse", "stop", "sessionEnd"]),
  grok: new Set(["Stop", "StopFailure", "StopCancelled", "SessionEnd"]),
} satisfies Record<NativeRuntime, ReadonlySet<string>>;

export const shouldCaptureNativeRun = (wake: NativeWakeV1): boolean =>
  RAW_HOOK_CAPTURE_RUNTIMES.has(wake.runtime) &&
  wake.exclusion !== "inference-session" &&
  captureEvents[wake.runtime].has(wake.eventName);

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const safeSegment = (value: string) => value.replace(/[^a-zA-Z0-9._-]/gu, "_") || "unknown";

const canonicalTranscriptPath = (runtime: RawCaptureRuntime, transcriptPath: string) =>
  runtime === "codex"
    ? transcriptPath
        .split(path.sep)
        .map((segment) => (segment === "archived_sessions" ? "sessions" : segment))
        .join(path.sep)
    : transcriptPath;

const sourceIdentity = (input: {
  runtime: RawCaptureRuntime;
  machineId: string;
  sessionId: string;
  transcriptPath: string;
}) =>
  `sha256:${sha256(
    JSON.stringify([
      input.runtime,
      input.machineId,
      input.sessionId,
      canonicalTranscriptPath(input.runtime, input.transcriptPath),
    ]),
  )}`;

const stateKey = (runtime: RawCaptureRuntime, sessionId: string, transcriptPath: string) =>
  sha256(JSON.stringify([runtime, sessionId, canonicalTranscriptPath(runtime, transcriptPath)]));

const pathsFor = (home: string, machineId: string, runtime: RawCaptureRuntime) => {
  const root = path.join(home, ".joelclaw", "capture", safeSegment(machineId), runtime);
  return {
    logPath: path.join(root, "capture.log"),
    outboxDir: path.join(root, "outbox"),
    stateDir: path.join(root, "state"),
  };
};

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readJsonObject = async (filePath: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return objectValue(value);
  } catch {
    return undefined;
  }
};

const readAuth = async (filePath: string): Promise<CaptureAuth | undefined> => {
  const value = await readJsonObject(filePath);
  return typeof value?.machine_id === "string" &&
    value.machine_id.length > 0 &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.user_id === "string" &&
    value.user_id.length > 0
    ? {
        machine_id: value.machine_id,
        token: value.token,
        user_id: value.user_id,
      }
    : undefined;
};

const readState = async (filePath: string): Promise<CaptureState | undefined> => {
  const value = await readJsonObject(filePath);
  if (
    value === undefined ||
    typeof value.source_identity !== "string" ||
    !Number.isSafeInteger(value.last_byte_offset) ||
    Number(value.last_byte_offset) < 0 ||
    typeof value.last_captured_at !== "string" ||
    (value.last_run_id !== null && typeof value.last_run_id !== "string")
  ) {
    return undefined;
  }
  return {
    source_identity: value.source_identity,
    last_byte_offset: Number(value.last_byte_offset),
    last_captured_at: value.last_captured_at,
    last_run_id: value.last_run_id as string | null,
  };
};

const writeJsonAtomic = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

const appendFailure = async (input: {
  code: Extract<RawCaptureResult, { status: "degraded" }>["code"];
  home: string;
  machineId: string;
  runtime: RawCaptureRuntime;
  sourceIdentity?: string;
}) => {
  const { logPath } = pathsFor(input.home, input.machineId, input.runtime);
  const event = {
    action: "memory.run.capture.failed",
    component: "native-run-capture",
    error: input.code,
    level: "warn",
    metadata: {
      runtime: input.runtime,
      ...(input.sourceIdentity === undefined
        ? {}
        : { source_identity_sha256: input.sourceIdentity.slice("sha256:".length) }),
    },
    source: "memory",
    success: false,
    timestamp: new Date().toISOString(),
  };
  try {
    await mkdir(path.dirname(logPath), { mode: 0o700, recursive: true });
    await appendFile(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch {
    // Capture must fail open even when local diagnostics are unavailable.
  }
};

const resolveCaptureUrl = (env: Readonly<Record<string, string | undefined>>): string | undefined => {
  const raw = env.JOELCLAW_SESSION_CAPTURE_URL ?? env.JOELCLAW_CENTRAL_URL ?? "http://127.0.0.1:3111";
  const value = raw.trim().replace(/\/$/u, "");
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
};

const pendingPath = (outboxDir: string, identity: string, fromOffset: number) =>
  path.join(outboxDir, `pending-${sha256(`${identity}:${fromOffset}`).slice(0, 26)}.json`);

const degraded = async (
  code: Extract<RawCaptureResult, { status: "degraded" }>["code"],
  context: {
    home: string;
    machineId: string;
    runtime: RawCaptureRuntime;
    sourceIdentity?: string;
  },
): Promise<RawCaptureResult> => {
  await appendFailure({ code, ...context });
  return { status: "degraded", code };
};

export async function captureNativeRun(
  wake: NativeWakeV1,
  dependencies: RawCaptureDependencies = {},
): Promise<RawCaptureResult> {
  if (!shouldCaptureNativeRun(wake)) return { status: "noop", reason: "event" };

  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? env.HOME ?? homedir();
  const runtime = rawRuntime(wake.runtime);
  const authPath = env.JOELCLAW_AUTH_PATH ?? path.join(home, ".joelclaw", "auth.json");
  const auth = await readAuth(authPath);
  if (auth === undefined) {
    return degraded("auth-invalid", { home, machineId: "unknown", runtime });
  }

  const identity = sourceIdentity({
    runtime,
    machineId: auth.machine_id,
    sessionId: wake.sessionId,
    transcriptPath: wake.transcriptPath,
  });
  const failureContext = {
    home,
    machineId: auth.machine_id,
    runtime,
    sourceIdentity: identity,
  };
  const captureUrl = resolveCaptureUrl(env);
  if (captureUrl === undefined) return degraded("capture-url-invalid", failureContext);
  try {
    await (dependencies.verifySource ?? verifyNativeSource)(wake);
  } catch {
    return degraded("source-untrusted", failureContext);
  }

  let currentSize: number;
  let full: Uint8Array;
  try {
    await stat(wake.transcriptPath);
    full = new Uint8Array(await readFile(wake.transcriptPath));
    currentSize = full.byteLength;
  } catch {
    return degraded("source-unavailable", failureContext);
  }

  const capturePaths = pathsFor(home, auth.machine_id, runtime);
  const key = stateKey(runtime, wake.sessionId, wake.transcriptPath);
  const statePath = path.join(capturePaths.stateDir, `${key}.json`);
  const prior = await readState(statePath);
  const trustedPrior = prior?.source_identity === identity ? prior : undefined;
  const fromOffset = trustedPrior?.last_byte_offset ?? 0;
  if (currentSize < fromOffset) return degraded("source-shrank", failureContext);
  if (currentSize === fromOffset) return { status: "noop", reason: "no-new-bytes" };

  const deltaBytes = full.subarray(fromOffset);
  const jsonl = Buffer.from(deltaBytes).toString("utf8");
  if (jsonl.trim().length === 0) return { status: "noop", reason: "empty" };

  const outboxPath = pendingPath(capturePaths.outboxDir, identity, fromOffset);
  const pending = await readJsonObject(outboxPath);
  const pendingBody = objectValue(pending?.body) ?? pending;
  const makeRunId = dependencies.runId ?? (() => randomUUID().replaceAll("-", "").slice(0, 26));
  const runId = typeof pendingBody?.run_id === "string" ? pendingBody.run_id : makeRunId();
  const digest = sha256(deltaBytes);
  const now = dependencies.now ?? Date.now;
  const eventId = `capture:${sha256(
    JSON.stringify([runtime, identity, fromOffset, digest]),
  ).slice(0, 40)}`;
  const body = {
    run_id: runId,
    agent_runtime: runtime,
    started_at:
      typeof pendingBody?.started_at === "number" ? pendingBody.started_at : now(),
    parent_run_id: trustedPrior?.last_run_id ?? undefined,
    conversation_id: wake.sessionId,
    source_session_id: wake.sessionId,
    event_id: eventId,
    tags: ["captured", `runtime:${runtime}`, `trigger:${wake.eventName}`],
    source_identity: identity,
    from_offset: fromOffset,
    to_offset: currentSize,
    jsonl_sha256: digest,
    jsonl,
  };

  const envelope: PendingCaptureEnvelope = {
    schema_version: 1,
    state_key: key,
    wake,
    body,
  };
  await writeJsonAtomic(outboxPath, envelope);

  let response: Response;
  try {
    const timeoutMs =
      dependencies.httpTimeoutMs ??
      positiveInteger(env.JOELCLAW_CAPTURE_HTTP_TIMEOUT_MS, DEFAULT_HTTP_TIMEOUT_MS);
    response = await (dependencies.fetch ?? fetch)(`${captureUrl}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `sha256:${sha256(
          JSON.stringify([auth.machine_id, runtime, identity, fromOffset, digest]),
        )}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return degraded("network-failed", failureContext);
  }
  if (!response.ok) return degraded("network-failed", failureContext);

  let accepted: CaptureResponse;
  try {
    accepted = (await response.json()) as CaptureResponse;
  } catch {
    return degraded("response-invalid", failureContext);
  }
  const acceptedOffset = strictAcceptedOffset(accepted.to_offset);
  const acceptedRunId = accepted.run_id;
  if (
    (accepted.status !== "accepted" && accepted.status !== "accepted_prefix") ||
    typeof acceptedRunId !== "string" ||
    acceptedRunId.length === 0 ||
    acceptedOffset === undefined ||
    acceptedOffset <= fromOffset ||
    acceptedOffset > currentSize ||
    (accepted.status === "accepted" && acceptedOffset !== currentSize)
  ) {
    return degraded("response-invalid", failureContext);
  }
  let suffixPath: string | undefined;
  if (acceptedOffset < currentSize) {
    const acceptedBytes = acceptedOffset - fromOffset;
    const suffixBytes = deltaBytes.subarray(acceptedBytes);
    const suffixJsonl = Buffer.from(suffixBytes).toString("utf8");
    if (Buffer.byteLength(suffixJsonl) !== suffixBytes.length) {
      return degraded("response-invalid", failureContext);
    }
    const suffixDigest = sha256(suffixBytes);
    const suffixBody = {
      ...body,
      run_id: makeRunId(),
      parent_run_id: acceptedRunId,
      started_at: now(),
      from_offset: acceptedOffset,
      jsonl: suffixJsonl,
      jsonl_sha256: suffixDigest,
      event_id: `capture:${sha256(
        JSON.stringify([runtime, identity, acceptedOffset, suffixDigest]),
      ).slice(0, 40)}`,
    };
    suffixPath = pendingPath(capturePaths.outboxDir, identity, acceptedOffset);
    await writeJsonAtomic(suffixPath, {
      schema_version: 1,
      state_key: key,
      wake,
      body: suffixBody,
    } satisfies PendingCaptureEnvelope);
  }
  const nextState: CaptureState = {
    source_identity: identity,
    last_byte_offset: acceptedOffset,
    last_captured_at: new Date(now()).toISOString(),
    last_run_id: acceptedRunId,
  };
  try {
    await writeJsonAtomic(statePath, nextState);
  } catch {
    return degraded("state-write-failed", failureContext);
  }
  if (suffixPath !== outboxPath) {
    await unlink(outboxPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return { status: "accepted", runId: acceptedRunId, toOffset: acceptedOffset };
}

const nativeWake = (value: unknown): NativeWakeV1 | undefined => {
  const wake = objectValue(value);
  if (
    wake?.schemaVersion !== 1 ||
    typeof wake.close !== "boolean" ||
    typeof wake.eventId !== "string" ||
    typeof wake.eventName !== "string" ||
    typeof wake.incarnationId !== "string" ||
    typeof wake.occurredAt !== "string" ||
    (wake.runtime !== "pi" &&
      wake.runtime !== "claude" &&
      wake.runtime !== "codex" &&
      wake.runtime !== "cursor" &&
      wake.runtime !== "grok") ||
    typeof wake.sessionId !== "string" ||
    typeof wake.transcriptPath !== "string"
  ) {
    return undefined;
  }
  return wake as unknown as NativeWakeV1;
};

const pendingEnvelope = async (
  filePath: string,
): Promise<PendingCaptureEnvelope | undefined> => {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const value = await readJsonObject(filePath);
  const wake = nativeWake(value?.wake);
  const body = objectValue(value?.body);
  if (
    value?.schema_version !== 1 ||
    typeof value.state_key !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.state_key) ||
    wake === undefined ||
    body === undefined ||
    !shouldCaptureNativeRun(wake) ||
    value.state_key !== stateKey(rawRuntime(wake.runtime), wake.sessionId, wake.transcriptPath)
  ) {
    return undefined;
  }
  return {
    schema_version: 1,
    state_key: value.state_key,
    wake,
    body,
  };
};

interface StoredCaptureBody extends Record<string, unknown> {
  readonly agent_runtime: RawCaptureRuntime;
  readonly from_offset: number;
  readonly jsonl: string;
  readonly jsonl_sha256: string;
  readonly run_id: string;
  readonly source_identity: string;
  readonly started_at: number;
  readonly to_offset: number;
}

const storedCaptureBody = (
  body: Record<string, unknown>,
  wake: NativeWakeV1,
  machineId: string,
): StoredCaptureBody | undefined => {
  const expectedRuntime = rawRuntime(wake.runtime);
  const expectedSource = sourceIdentity({
    machineId,
    runtime: expectedRuntime,
    sessionId: wake.sessionId,
    transcriptPath: wake.transcriptPath,
  });
  if (
    body.agent_runtime !== expectedRuntime ||
    typeof body.from_offset !== "number" ||
    !Number.isSafeInteger(body.from_offset) ||
    body.from_offset < 0 ||
    typeof body.to_offset !== "number" ||
    !Number.isSafeInteger(body.to_offset) ||
    body.to_offset <= body.from_offset ||
    typeof body.jsonl !== "string" ||
    Buffer.byteLength(body.jsonl) !== body.to_offset - body.from_offset ||
    typeof body.jsonl_sha256 !== "string" ||
    body.jsonl_sha256 !== sha256(body.jsonl) ||
    typeof body.run_id !== "string" ||
    body.run_id.length === 0 ||
    body.source_identity !== expectedSource ||
    typeof body.started_at !== "number" ||
    !Number.isFinite(body.started_at)
  ) {
    return undefined;
  }
  return body as StoredCaptureBody;
};

/**
 * Replays only the namespaced v1 envelopes written by this adapter. It never
 * scans or imports the retired ~/.joelclaw/outbox directory.
 */
export async function replayNativeRunCaptureOutboxes(
  dependencies: RawCaptureDependencies = {},
): Promise<RawCaptureReplayReceipt> {
  const receipt = { accepted: 0, attempted: 0, failed: 0, invalid: 0, stale: 0 };
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? env.HOME ?? homedir();
  const authPath = env.JOELCLAW_AUTH_PATH ?? path.join(home, ".joelclaw", "auth.json");
  const auth = await readAuth(authPath);
  if (auth === undefined) return { ...receipt, failed: 1 };
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const makeRunId = dependencies.runId ?? (() => randomUUID().replaceAll("-", "").slice(0, 26));
  const captureUrl = resolveCaptureUrl(env);
  if (captureUrl === undefined) return { ...receipt, failed: 1 };
  const timeoutMs =
    dependencies.httpTimeoutMs ??
    positiveInteger(env.JOELCLAW_CAPTURE_HTTP_TIMEOUT_MS, DEFAULT_HTTP_TIMEOUT_MS);

  for (const runtime of ["pi", "claude-code", "codex"] as const) {
    const { outboxDir, stateDir } = pathsFor(home, auth.machine_id, runtime);
    let files: string[];
    try {
      files = (await readdir(outboxDir))
        .filter((name) => /^pending-[0-9a-f]{26}\.json$/u.test(name))
        .sort();
    } catch {
      continue;
    }
    for (const name of files) {
      let activePath = path.join(outboxDir, name);
      let envelope = await pendingEnvelope(activePath);
      if (envelope === undefined) {
        receipt.invalid += 1;
        continue;
      }
      receipt.attempted += 1;
      let settled = false;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const body = storedCaptureBody(envelope.body, envelope.wake, auth.machine_id);
        if (body === undefined) {
          receipt.invalid += 1;
          settled = true;
          break;
        }
        const statePath = path.join(stateDir, `${envelope.state_key}.json`);
        const state = await readState(statePath);
        if (
          state?.source_identity === body.source_identity &&
          state.last_byte_offset >= body.to_offset
        ) {
          await unlink(activePath).catch(() => undefined);
          receipt.stale += 1;
          settled = true;
          break;
        }

        const replayFailure = (
          code: Extract<RawCaptureResult, { status: "degraded" }>["code"],
        ) =>
          appendFailure({
            code,
            home,
            machineId: auth.machine_id,
            runtime: body.agent_runtime,
            sourceIdentity: body.source_identity,
          });
        let response: Response;
        try {
          response = await fetchImpl(`${captureUrl}/api/runs`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${auth.token}`,
              "content-type": "application/json",
              "idempotency-key": `sha256:${sha256(
                `${body.source_identity}:${body.from_offset}:${body.to_offset}:${body.jsonl_sha256}`,
              )}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          await replayFailure("network-failed");
          receipt.failed += 1;
          settled = true;
          break;
        }
        if (!response.ok) {
          await replayFailure("network-failed");
          receipt.failed += 1;
          settled = true;
          break;
        }
        let accepted: CaptureResponse;
        try {
          accepted = (await response.json()) as CaptureResponse;
        } catch {
          await replayFailure("response-invalid");
          receipt.failed += 1;
          settled = true;
          break;
        }
        const acceptedOffset = strictAcceptedOffset(accepted.to_offset);
        const acceptedRunId = accepted.run_id;
        if (
          (accepted.status !== "accepted" && accepted.status !== "accepted_prefix") ||
          typeof acceptedRunId !== "string" ||
          acceptedRunId.length === 0 ||
          acceptedOffset === undefined ||
          acceptedOffset <= body.from_offset ||
          acceptedOffset > body.to_offset ||
          (accepted.status === "accepted" && acceptedOffset !== body.to_offset)
        ) {
          await replayFailure("response-invalid");
          receipt.failed += 1;
          settled = true;
          break;
        }

        let suffixJsonl: string | undefined;
        if (acceptedOffset < body.to_offset) {
          const acceptedBytes = acceptedOffset - body.from_offset;
          const suffixBytes = Buffer.from(body.jsonl).subarray(acceptedBytes);
          suffixJsonl = suffixBytes.toString("utf8");
          if (Buffer.byteLength(suffixJsonl) !== suffixBytes.length) {
            await replayFailure("response-invalid");
            receipt.failed += 1;
            settled = true;
            break;
          }
        }
        receipt.accepted += 1;
        await writeJsonAtomic(statePath, {
          source_identity: body.source_identity,
          last_byte_offset: acceptedOffset,
          last_captured_at: new Date(now()).toISOString(),
          last_run_id: acceptedRunId,
        } satisfies CaptureState);
        if (acceptedOffset === body.to_offset) {
          await unlink(activePath).catch(() => undefined);
          settled = true;
          break;
        }

        if (suffixJsonl === undefined) {
          receipt.failed += 1;
          settled = true;
          break;
        }
        const suffixDigest = sha256(suffixJsonl);
        const suffixBody: StoredCaptureBody = {
          ...body,
          run_id: makeRunId(),
          parent_run_id: acceptedRunId,
          from_offset: acceptedOffset,
          jsonl: suffixJsonl,
          jsonl_sha256: suffixDigest,
          started_at: now(),
          event_id: `capture:${sha256(
            JSON.stringify([
              body.agent_runtime,
              body.source_identity,
              acceptedOffset,
              suffixDigest,
            ]),
          ).slice(0, 40)}`,
        };
        const suffixPath = pendingPath(
          outboxDir,
          body.source_identity,
          acceptedOffset,
        );
        envelope = { ...envelope, body: suffixBody };
        await writeJsonAtomic(suffixPath, envelope);
        await unlink(activePath).catch(() => undefined);
        activePath = suffixPath;
      }
      if (!settled) receipt.failed += 1;
    }
  }
  return receipt;
}

export function scheduleNativeRunCapture(
  wake: NativeWakeV1,
  dependencies: RawCaptureDependencies = {},
): Promise<void> {
  const key = `${wake.runtime}:${wake.sessionId}:${wake.transcriptPath}`;
  const existing = captureWorkers.get(key);
  if (existing !== undefined) {
    existing.pending = { wake, dependencies };
    return existing.running;
  }
  const worker = {
    pending: { wake, dependencies } as
      | { wake: NativeWakeV1; dependencies: RawCaptureDependencies }
      | undefined,
    running: Promise.resolve(),
  };
  captureWorkers.set(key, worker);
  worker.running = Promise.resolve()
    .then(async () => {
      while (worker.pending !== undefined) {
        const next = worker.pending;
        worker.pending = undefined;
        await captureNativeRun(next.wake, next.dependencies).catch(() => undefined);
      }
    })
    .finally(() => {
      if (captureWorkers.get(key) === worker) captureWorkers.delete(key);
    });
  return worker.running;
}

export async function flushNativeRunCaptureQueue(): Promise<void> {
  await Promise.allSettled([...captureWorkers.values()].map((worker) => worker.running));
}
