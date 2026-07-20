import { createHash } from "node:crypto";

export type CaptureBody = {
  run_id: string;
  agent_runtime: "pi" | "claude-code" | "codex";
  conversation_id?: string;
  parent_run_id?: string;
  started_at: number;
  tags?: string[];
  jsonl: string;
  from_offset?: number;
  to_offset?: number;
  jsonl_sha256?: string;
  source_identity?: string;
  [key: string]: unknown;
};

export type CatalogEntry = {
  path: string;
  file: string;
  fileBytes: number;
  mtimeMs: number;
  runId: string;
  runtime: CaptureBody["agent_runtime"];
  conversationId?: string;
  parentRunId?: string;
  sourceIdentity?: string;
  fromOffset?: number;
  startedAt: number;
  jsonlChars: number;
  jsonlBytes: number;
  jsonlSha256: string;
  bodySha256: string;
  disposition?: "representative" | "redundant-prefix" | "redundant-exact";
  supersededBy?: string;
};

export type CapturedSibling = {
  runId: string;
  jsonl: string;
  jsonlSha256: string;
};

export type ReplayCheckpointStatus = "inflight" | "accepted" | "indexed" | "covered" | "failed";

export type ReplayDerivation =
  | { status: "covered"; capturedRunId: string }
  | { status: "full"; body: CaptureBody; replaySha256: string }
  | {
      status: "suffix";
      body: CaptureBody;
      replaySha256: string;
      capturedRunId: string;
      removedPrefixBytes: number;
    };

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseCaptureBody(value: unknown): CaptureBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture body must be an object");
  }
  const body = value as Partial<CaptureBody>;
  if (!body.run_id || !/^[0-9a-f]{26}$/u.test(body.run_id)) {
    throw new Error("capture body has invalid run_id");
  }
  if (!body.agent_runtime || !["pi", "claude-code", "codex"].includes(body.agent_runtime)) {
    throw new Error("capture body has invalid agent_runtime");
  }
  if (!Number.isFinite(body.started_at)) {
    throw new Error("capture body has invalid started_at");
  }
  if (typeof body.jsonl !== "string" || !body.jsonl.trim()) {
    throw new Error("capture body has empty jsonl");
  }
  const segmentFields = [body.from_offset, body.to_offset, body.jsonl_sha256, body.source_identity];
  if (segmentFields.some((field) => field !== undefined)) {
    if (
      !Number.isSafeInteger(body.from_offset) ||
      !Number.isSafeInteger(body.to_offset) ||
      (body.from_offset as number) < 0 ||
      (body.to_offset as number) < (body.from_offset as number)
    ) {
      throw new Error("capture body has invalid byte offsets");
    }
    if (body.to_offset - body.from_offset !== Buffer.byteLength(body.jsonl, "utf8")) {
      throw new Error("capture body byte range does not match jsonl");
    }
    if (typeof body.jsonl_sha256 !== "string" || body.jsonl_sha256 !== sha256(body.jsonl)) {
      throw new Error("capture body jsonl_sha256 mismatch");
    }
    if (typeof body.source_identity !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(body.source_identity)) {
      throw new Error("capture body has invalid source_identity");
    }
  }
  return body as CaptureBody;
}

export function captureSourceIdentity(parts: readonly string[]): string {
  return `sha256:${sha256(JSON.stringify(parts))}`;
}

export function pendingCaptureFileName(sourceIdentity: string, fromOffset: number): string {
  return `pending-${sha256(`${sourceIdentity}:${fromOffset}`).slice(0, 26)}.json`;
}

export function coalescePendingCapture(
  pending: CaptureBody | undefined,
  next: CaptureBody,
): CaptureBody {
  if (!pending) return next;
  if (
    pending.source_identity !== next.source_identity ||
    pending.from_offset !== next.from_offset ||
    pending.agent_runtime !== next.agent_runtime ||
    pending.conversation_id !== next.conversation_id
  ) {
    throw new Error("pending capture does not match stale cursor");
  }
  return {
    ...next,
    run_id: pending.run_id,
    started_at: pending.started_at,
    parent_run_id: pending.parent_run_id,
  };
}

export function logicalGroupKey(
  value: Pick<
    CatalogEntry,
    "runtime" | "conversationId" | "parentRunId" | "sourceIdentity" | "fromOffset"
  >,
): string {
  if (value.sourceIdentity !== undefined && value.fromOffset !== undefined) {
    return JSON.stringify([value.sourceIdentity, value.fromOffset]);
  }
  return JSON.stringify([value.runtime, value.conversationId ?? null, value.parentRunId ?? null]);
}

export function classifyPrefixGroup(
  entries: CatalogEntry[],
  readJsonl: (entry: CatalogEntry) => string,
): CatalogEntry[] {
  const retained: Array<{ entry: CatalogEntry; jsonl: string }> = [];
  const ordered = [...entries].sort(
    (a, b) => b.jsonlChars - a.jsonlChars || b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file),
  );

  return ordered.map((entry) => {
    const jsonl = readJsonl(entry);
    const covering = retained.find((candidate) => candidate.jsonl.startsWith(jsonl));
    if (covering) {
      return {
        ...entry,
        disposition:
          covering.jsonl.length === jsonl.length && covering.entry.jsonlSha256 === entry.jsonlSha256
            ? "redundant-exact"
            : "redundant-prefix",
        supersededBy: covering.entry.runId,
      };
    }
    const representative = { ...entry, disposition: "representative" as const };
    retained.push({ entry: representative, jsonl });
    return representative;
  });
}

export function catalogEntryMatches(expected: CatalogEntry, actual: CatalogEntry): boolean {
  return (
    expected.path === actual.path &&
    expected.file === actual.file &&
    expected.fileBytes === actual.fileBytes &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.runId === actual.runId &&
    expected.runtime === actual.runtime &&
    expected.conversationId === actual.conversationId &&
    expected.parentRunId === actual.parentRunId &&
    expected.sourceIdentity === actual.sourceIdentity &&
    expected.fromOffset === actual.fromOffset &&
    expected.startedAt === actual.startedAt &&
    expected.jsonlChars === actual.jsonlChars &&
    expected.jsonlBytes === actual.jsonlBytes &&
    expected.jsonlSha256 === actual.jsonlSha256 &&
    expected.bodySha256 === actual.bodySha256
  );
}

export function isPathInside(root: string, path: string, relativePath: string): boolean {
  return (
    path !== root &&
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${pathSeparator()}`) &&
    !relativePath.startsWith("/")
  );
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export function verifiedCapturedSibling(
  runId: string,
  jsonl: string,
  indexedSha256: string | undefined,
): CapturedSibling {
  if (!indexedSha256) throw new Error(`captured sibling ${runId} is missing indexed jsonl_sha256`);
  const actualSha256 = sha256(jsonl);
  if (actualSha256 !== indexedSha256) {
    throw new Error(`captured sibling ${runId} raw/indexed SHA mismatch`);
  }
  return { runId, jsonl, jsonlSha256: indexedSha256 };
}

export function canAttemptReplay(
  priorStatus: ReplayCheckpointStatus | undefined,
  runId: string,
  retryFailedRun: string | undefined,
): boolean {
  if (!priorStatus) return true;
  if (priorStatus === "failed") return retryFailedRun === runId;
  return false;
}

export function deriveReplayBody(
  source: CaptureBody,
  capturedSiblings: CapturedSibling[],
): ReplayDerivation {
  let covering: CapturedSibling | undefined;
  let longestPrefix: CapturedSibling | undefined;

  for (const sibling of capturedSiblings) {
    if (sibling.jsonl.startsWith(source.jsonl)) {
      if (!covering || sibling.jsonl.length < covering.jsonl.length) covering = sibling;
      continue;
    }
    if (source.jsonl.startsWith(sibling.jsonl)) {
      if (!longestPrefix || sibling.jsonl.length > longestPrefix.jsonl.length)
        longestPrefix = sibling;
    }
  }

  if (covering) return { status: "covered", capturedRunId: covering.runId };
  if (!longestPrefix) {
    return { status: "full", body: source, replaySha256: sha256(source.jsonl) };
  }

  const suffix = source.jsonl.slice(longestPrefix.jsonl.length);
  if (!suffix.trim()) return { status: "covered", capturedRunId: longestPrefix.runId };
  const removedPrefixBytes = Buffer.byteLength(longestPrefix.jsonl, "utf8");
  const suffixRunId =
    longestPrefix.runId === source.run_id
      ? sha256(
          JSON.stringify([
            source.run_id,
            source.from_offset ?? null,
            removedPrefixBytes,
            sha256(suffix),
          ]),
        ).slice(0, 26)
      : source.run_id;
  const body: CaptureBody = {
    ...source,
    run_id: suffixRunId,
    parent_run_id: longestPrefix.runId,
    jsonl: suffix,
    ...(source.from_offset !== undefined
      ? {
          from_offset: source.from_offset + removedPrefixBytes,
          jsonl_sha256: sha256(suffix),
        }
      : {}),
    tags: [...new Set([...(source.tags ?? []), "outbox-replay", "prefix-trimmed"])],
  };
  return {
    status: "suffix",
    body,
    replaySha256: sha256(suffix),
    capturedRunId: longestPrefix.runId,
    removedPrefixBytes,
  };
}

export function replayKey(runId: string, sourceSha256: string, replaySha256: string): string {
  return `${runId}:${sourceSha256}:${replaySha256}`;
}
