import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const FLOWING_MEMORY_INTERNAL_MARKER_V1 = "joelclaw-flowing-memory-inference:v1" as const;

export type NativeRuntime = "claude" | "codex" | "cursor" | "grok" | "pi";

export interface NativeWakeV1 {
  readonly close: boolean;
  readonly cwd?: string;
  readonly eventId: string;
  readonly exclusion?: "inference-session";
  readonly incarnationId: string;
  readonly eventName: string;
  readonly occurredAt: string;
  readonly runtime: NativeRuntime;
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly transcriptPath: string;
}

export type DecodeResult =
  | { readonly _tag: "Accepted"; readonly wake: NativeWakeV1 }
  | { readonly _tag: "Rejected"; readonly code: "invalid-event" | "invalid-source" }
  | { readonly _tag: "Skipped"; readonly reason: "inference-session" | "unrelated-event" };

export interface NativeDecodeOptionsV1 {
  readonly captureInferenceSession?: boolean;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const firstText = (input: Record<string, unknown>, ...keys: readonly string[]) => {
  for (const key of keys) {
    const value = text(input[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const canonicalEventId = (input: {
  readonly eventName: string;
  readonly occurredAt: string;
  readonly runtime: NativeRuntime;
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly incarnationId: string;
}) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "native-wake:v1",
        input.runtime,
        input.sessionId,
        input.incarnationId,
        input.eventName,
        input.occurredAt,
        createHash("sha256").update(input.transcriptPath).digest("hex"),
      ]),
    )
    .digest("hex");

const accepted = (input: {
  readonly close: boolean;
  readonly cwd?: string;
  readonly eventName: string;
  readonly occurredAt?: string;
  readonly runtime: NativeRuntime;
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly incarnationId?: string;
  readonly exclusion?: "inference-session";
}): DecodeResult => {
  if (!path.isAbsolute(input.transcriptPath)) {
    return { _tag: "Rejected", code: "invalid-source" };
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(occurredAt))) {
    return { _tag: "Rejected", code: "invalid-event" };
  }
  const incarnationId =
    input.incarnationId ??
    `legacy-${input.runtime}-${createHash("sha256").update(input.sessionId).digest("hex").slice(0, 16)}`;
  return {
    _tag: "Accepted",
    wake: {
      close: input.close,
      ...(input.cwd === undefined ? {} : { cwd: path.resolve(input.cwd) }),
      ...(input.exclusion === undefined ? {} : { exclusion: input.exclusion }),
      eventId: canonicalEventId({ ...input, occurredAt, incarnationId }),
      incarnationId,
      eventName: input.eventName,
      occurredAt,
      runtime: input.runtime,
      schemaVersion: 1,
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath,
    },
  };
};

export const withIncarnation = (wake: NativeWakeV1, incarnationId: string): NativeWakeV1 => ({
  ...wake,
  eventId: canonicalEventId({ ...wake, incarnationId }),
  incarnationId,
});

const rejectsCamelCase = (input: Record<string, unknown>) =>
  Object.keys(input).some((key) => /[a-z][A-Z]/u.test(key));

const incarnationOption = (input: Record<string, unknown>): { readonly incarnationId?: string } => {
  const value = text(input.incarnation_id);
  return value === undefined ? {} : { incarnationId: value };
};

const isOneOf = (value: string, values: readonly string[]) => values.includes(value);

export const decodeNativeEvent = (
  runtime: Exclude<NativeRuntime, "grok">,
  value: unknown,
  options: NativeDecodeOptionsV1 = {},
): DecodeResult => {
  const input = object(value);
  if (input === undefined || (runtime !== "pi" && rejectsCamelCase(input))) {
    return { _tag: "Rejected", code: "invalid-event" };
  }
  if (input.internal_marker === FLOWING_MEMORY_INTERNAL_MARKER_V1) {
    if (options.captureInferenceSession === true) {
      const sessionId = firstText(input, "session_id", "thread_id", "conversation_id");
      const transcriptPath = text(input.transcript_path);
      const eventName = firstText(input, "event_name", "hook_event_name") ?? "inference-session";
      if (sessionId !== undefined && transcriptPath !== undefined) {
        return accepted({
          close: false,
          eventName,
          runtime,
          sessionId,
          transcriptPath,
          exclusion: "inference-session",
        });
      }
    }
    return { _tag: "Skipped", reason: "inference-session" };
  }
  const occurredAt = text(input.occurred_at);
  const cwd = firstText(input, "cwd", "workspace_root");
  const cwdOption = cwd === undefined ? {} : { cwd };
  switch (runtime) {
    case "pi": {
      const eventName = text(input.event_name);
      const sessionId = text(input.session_id);
      const transcriptPath = text(input.transcript_path);
      if (eventName === undefined || sessionId === undefined || transcriptPath === undefined) {
        return { _tag: "Rejected", code: "invalid-event" };
      }
      if (!isOneOf(eventName, ["session_start", "turn_end", "session_shutdown"])) {
        return { _tag: "Skipped", reason: "unrelated-event" };
      }
      return accepted({
        close: eventName === "session_shutdown",
        ...cwdOption,
        eventName,
        ...(occurredAt === undefined ? {} : { occurredAt }),
        runtime,
        sessionId,
        transcriptPath,
        ...incarnationOption(input),
      });
    }
    case "claude": {
      const eventName = text(input.hook_event_name);
      const sessionId = text(input.session_id);
      const transcriptPath = text(input.transcript_path);
      if (eventName === undefined || sessionId === undefined || transcriptPath === undefined) {
        return { _tag: "Rejected", code: "invalid-event" };
      }
      if (
        !isOneOf(eventName, ["SessionStart", "PostToolBatch", "Stop", "StopFailure", "SessionEnd"])
      ) {
        return { _tag: "Skipped", reason: "unrelated-event" };
      }
      return accepted({
        close: eventName === "SessionEnd",
        ...cwdOption,
        eventName,
        ...(occurredAt === undefined ? {} : { occurredAt }),
        runtime,
        sessionId,
        transcriptPath,
        ...incarnationOption(input),
      });
    }
    case "codex": {
      const eventName = firstText(input, "event_name", "hook_event_name");
      const sessionId = firstText(input, "thread_id", "session_id");
      const transcriptPath = text(input.transcript_path);
      if (eventName === undefined || sessionId === undefined || transcriptPath === undefined) {
        return { _tag: "Rejected", code: "invalid-event" };
      }
      // Keep the two legacy aliases readable for old capture fixtures. New
      // hooks use the canonical Codex event names installed by the map.
      const canonicalEventName =
        eventName === "agent-turn-complete"
          ? "Stop"
          : eventName === "session-close"
            ? "SessionEnd"
            : eventName;
      if (!isOneOf(canonicalEventName, ["SessionStart", "PostToolUse", "Stop", "SessionEnd"])) {
        return { _tag: "Skipped", reason: "unrelated-event" };
      }
      return accepted({
        close: canonicalEventName === "SessionEnd",
        ...cwdOption,
        eventName: canonicalEventName,
        ...(occurredAt === undefined ? {} : { occurredAt }),
        runtime,
        sessionId,
        transcriptPath,
        ...incarnationOption(input),
      });
    }
    case "cursor": {
      const eventName = text(input.hook_event_name);
      const sessionId = text(input.conversation_id);
      const transcriptPath = text(input.transcript_path);
      if (eventName === undefined || sessionId === undefined || transcriptPath === undefined) {
        return { _tag: "Rejected", code: "invalid-event" };
      }
      if (!isOneOf(eventName, ["sessionStart", "afterAgentResponse", "stop", "sessionEnd"])) {
        return { _tag: "Skipped", reason: "unrelated-event" };
      }
      return accepted({
        close: eventName === "sessionEnd",
        ...cwdOption,
        eventName,
        ...(occurredAt === undefined ? {} : { occurredAt }),
        runtime,
        sessionId,
        transcriptPath,
        ...incarnationOption(input),
      });
    }
    default: {
      const exhaustive: never = runtime;
      return exhaustive;
    }
  }
};

const grokUpdatesPath = (input: Record<string, unknown>, sessionId: string) => {
  const explicitPath = firstText(input, "transcript_path", "updates_path");
  if (explicitPath !== undefined) return explicitPath;
  const explicitDirectory = firstText(input, "session_dir", "sessionDir");
  if (explicitDirectory !== undefined) return path.join(explicitDirectory, "updates.jsonl");
  const cwd = firstText(input, "cwd", "workspaceRoot", "workspace_root");
  if (cwd === undefined) return undefined;
  const encodedCwd = encodeURIComponent(path.resolve(cwd));
  return path.join(sourceRootFor("grok"), encodedCwd, sessionId, "updates.jsonl");
};

const sourceRootFor = (runtime: NativeRuntime) => {
  const configured = process.env[`JOELCLAW_FLOWING_MEMORY_${runtime.toUpperCase()}_SOURCE_ROOT`];
  if (configured !== undefined && configured.length > 0) return configured;
  switch (runtime) {
    case "claude":
      return path.join(homedir(), ".claude", "projects");
    case "codex":
      return path.join(homedir(), ".codex", "sessions");
    case "cursor":
      return path.join(homedir(), ".cursor", "projects");
    case "grok":
      return path.join(process.env.GROK_HOME ?? path.join(homedir(), ".grok"), "sessions");
    case "pi":
      return path.join(homedir(), ".pi", "agent", "sessions");
  }
};

const isWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const findUpdatesJsonl = async (directory: string, depth = 0): Promise<readonly string[]> => {
  if (depth > 2) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === "updates.jsonl") {
      matches.push(current);
    } else if (entry.isDirectory()) {
      matches.push(...(await findUpdatesJsonl(current, depth + 1)));
    }
  }
  return matches;
};

const summaryIdentityMatches = async (sessionDirectory: string, sessionId: string) => {
  try {
    const parsed = object(
      JSON.parse(await readFile(path.join(sessionDirectory, "summary.json"), "utf8")),
    );
    const info = object(parsed?.info);
    const identities = [
      parsed?.session_id,
      parsed?.sessionId,
      info?.id,
      info?.session_id,
      info?.sessionId,
    ].filter((candidate): candidate is string => typeof candidate === "string");
    return identities.includes(sessionId);
  } catch {
    return false;
  }
};

export interface NativeSourceScanOptionsV1 {
  readonly activeWindowMs?: number;
  readonly now?: () => number;
}

const sourceFiles = async (directory: string, depth = 0): Promise<readonly string[]> => {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(current, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(current);
    }
  }
  return files;
};

export const scanNativeSources = async (
  options: NativeSourceScanOptionsV1 = {},
): Promise<readonly NativeWakeV1[]> => {
  const now = options.now ?? Date.now;
  const activeWindowMs = options.activeWindowMs ?? 5 * 60_000;
  const wakes: NativeWakeV1[] = [];
  for (const runtime of ["pi", "claude", "codex", "cursor", "grok"] as const) {
    const root = sourceRootFor(runtime);
    const candidates = (await sourceFiles(root)).filter(
      (candidate) => runtime !== "grok" || path.basename(candidate) === "updates.jsonl",
    );
    for (const candidate of candidates) {
      let metadata;
      try {
        metadata = await stat(candidate);
      } catch {
        continue;
      }
      if (now() - metadata.mtimeMs > activeWindowMs) continue;
      const sessionId =
        runtime === "grok"
          ? ((await readFile(path.join(path.dirname(candidate), "summary.json"), "utf8")
              .then((value) => {
                const parsed = object(JSON.parse(value));
                return firstText(parsed ?? {}, "session_id", "sessionId");
              })
              .catch(() => undefined)) ?? path.basename(candidate, ".jsonl"))
          : path.basename(candidate, ".jsonl");
      const result = accepted({
        close: false,
        eventName: "active_source_scan",
        occurredAt: new Date(metadata.mtimeMs).toISOString(),
        runtime,
        sessionId,
        transcriptPath: candidate,
      });
      if (result._tag === "Accepted") wakes.push(result.wake);
    }
  }
  return wakes;
};

export const verifyNativeSource = async (wake: NativeWakeV1): Promise<void> => {
  const root = path.resolve(sourceRootFor(wake.runtime));
  const candidate = path.resolve(wake.transcriptPath);
  if (!isWithin(root, candidate)) throw new Error("invalid-source-root");
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isWithin(realRoot, realCandidate)) throw new Error("invalid-source-root");
  const metadata = await stat(realCandidate);
  if (!metadata.isFile()) throw new Error("invalid-source");
  if (wake.runtime !== "grok") return;
  const updates = await findUpdatesJsonl(path.dirname(realCandidate));
  if (updates.length !== 1 || path.resolve(updates[0] ?? "") !== path.resolve(realCandidate)) {
    throw new Error("grok-updates-identity-ambiguous");
  }
  let directory = path.dirname(realCandidate);
  for (let depth = 0; depth < 4 && isWithin(realRoot, directory); depth += 1) {
    if (await summaryIdentityMatches(directory, wake.sessionId)) return;
    directory = path.dirname(directory);
  }
  throw new Error("grok-summary-identity-mismatch");
};

const canonicalGrokEventName = (value: string) => {
  switch (value) {
    case "session_start":
    case "SessionStart":
    case "sessionStart":
      return "SessionStart";
    case "stop":
    case "Stop":
      return "Stop";
    case "stop_failure":
    case "StopFailure":
      return "StopFailure";
    case "stop_cancelled":
    case "StopCancelled":
      return "StopCancelled";
    case "notification":
    case "Notification":
      return "Notification";
    case "session_end":
    case "SessionEnd":
    case "sessionEnd":
      return "SessionEnd";
    default:
      return undefined;
  }
};

export const decodeGrokEvent = (
  value: unknown,
  options: NativeDecodeOptionsV1 = {},
): DecodeResult => {
  const input = object(value);
  if (input === undefined) return { _tag: "Rejected", code: "invalid-event" };
  if (
    input.internal_marker === FLOWING_MEMORY_INTERNAL_MARKER_V1 ||
    input.internalMarker === FLOWING_MEMORY_INTERNAL_MARKER_V1
  ) {
    if (options.captureInferenceSession === true) {
      const sessionId = firstText(input, "sessionId", "session_id", "conversation_id");
      const transcriptPath =
        sessionId === undefined ? undefined : grokUpdatesPath(input, sessionId);
      if (sessionId !== undefined && transcriptPath !== undefined) {
        return accepted({
          close: false,
          eventName: "inference-session",
          runtime: "grok",
          sessionId,
          transcriptPath,
          exclusion: "inference-session",
        });
      }
    }
    return { _tag: "Skipped", reason: "inference-session" };
  }
  if (text(input.subagentType) !== undefined || text(input.subagent_type) !== undefined) {
    return { _tag: "Rejected", code: "invalid-event" };
  }
  const rawEventName = firstText(input, "hookEventName", "hook_event_name", "event_name");
  const sessionId = firstText(input, "sessionId", "session_id", "conversation_id");
  if (rawEventName === undefined || sessionId === undefined) {
    return { _tag: "Rejected", code: "invalid-event" };
  }
  const eventName = canonicalGrokEventName(rawEventName);
  if (eventName === undefined) return { _tag: "Skipped", reason: "unrelated-event" };
  const transcriptPath = grokUpdatesPath(input, sessionId);
  if (transcriptPath === undefined) return { _tag: "Rejected", code: "invalid-source" };
  const occurredAt = firstText(input, "occurred_at", "timestamp");
  const cwd = firstText(input, "cwd", "workspaceRoot", "workspace_root");
  return accepted({
    close: eventName === "SessionEnd",
    ...(cwd === undefined ? {} : { cwd }),
    eventName,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    runtime: "grok",
    sessionId,
    transcriptPath,
    ...incarnationOption(input),
  });
};
