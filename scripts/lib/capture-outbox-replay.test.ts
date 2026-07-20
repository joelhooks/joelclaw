import { describe, expect, test } from "bun:test";
import {
  type CaptureBody,
  type CatalogEntry,
  canAttemptReplay,
  captureSourceIdentity,
  catalogEntryMatches,
  classifyPrefixGroup,
  coalescePendingCapture,
  deriveReplayBody,
  isPathInside,
  parseCaptureBody,
  pendingCaptureFileName,
  replayKey,
  sha256,
  verifiedCapturedSibling,
} from "./capture-outbox-replay";

function body(overrides: Partial<CaptureBody> = {}): CaptureBody {
  return {
    run_id: "a".repeat(26),
    agent_runtime: "pi",
    conversation_id: "conversation",
    started_at: 1_700_000_000_000,
    jsonl: "one\ntwo\n",
    ...overrides,
  };
}

function entry(runId: string, jsonl: string, mtimeMs: number): CatalogEntry {
  return {
    path: `/${runId}.json`,
    file: `${runId}.json`,
    fileBytes: Buffer.byteLength(jsonl),
    mtimeMs,
    runId,
    runtime: "pi",
    conversationId: "conversation",
    startedAt: 1_700_000_000_000,
    jsonlChars: jsonl.length,
    jsonlBytes: Buffer.byteLength(jsonl),
    jsonlSha256: sha256(jsonl),
    bodySha256: sha256(JSON.stringify(body({ run_id: runId, jsonl }))),
  };
}

describe("capture outbox replay", () => {
  test("validates the capture envelope", () => {
    expect(parseCaptureBody(body()).run_id).toBe("a".repeat(26));
    expect(() => parseCaptureBody({ ...body(), jsonl: "" })).toThrow("empty jsonl");
    expect(() => parseCaptureBody({ ...body(), agent_runtime: "unknown" })).toThrow(
      "invalid agent_runtime",
    );
  });

  test("coalesces a stale cursor into one stable pending segment", () => {
    const identity = captureSourceIdentity(["pi", "machine", "conversation", "/session.jsonl"]);
    const first = body({
      run_id: "a".repeat(26),
      source_identity: identity,
      from_offset: 10,
      to_offset: 14,
      jsonl: "one\n",
      jsonl_sha256: sha256("one\n"),
    });
    const later = body({
      run_id: "b".repeat(26),
      source_identity: identity,
      from_offset: 10,
      to_offset: 18,
      jsonl: "one\ntwo\n",
      jsonl_sha256: sha256("one\ntwo\n"),
    });

    const coalesced = coalescePendingCapture(first, later);
    expect(coalesced.run_id).toBe(first.run_id);
    expect(coalesced.started_at).toBe(first.started_at);
    expect(coalesced.to_offset).toBe(18);
    expect(coalesced.jsonl).toBe("one\ntwo\n");
    expect(pendingCaptureFileName(identity, 10)).toBe(pendingCaptureFileName(identity, 10));
  });

  test("keeps only the largest growing delta in a prefix-aware logical group", () => {
    const small = entry("a".repeat(26), "one\n", 1);
    const medium = entry("b".repeat(26), "one\ntwo\n", 2);
    const large = entry("c".repeat(26), "one\ntwo\nthree\n", 3);
    const text = new Map([
      [small.runId, "one\n"],
      [medium.runId, "one\ntwo\n"],
      [large.runId, "one\ntwo\nthree\n"],
    ]);

    const classified = classifyPrefixGroup([small, medium, large], (item) => text.get(item.runId)!);
    expect(classified.filter((item) => item.disposition === "representative")).toHaveLength(1);
    expect(classified.filter((item) => item.disposition === "redundant-prefix")).toHaveLength(2);
  });

  test("skips a delta already covered by a captured sibling", () => {
    const result = deriveReplayBody(body({ jsonl: "one\n" }), [
      { runId: "captured", jsonl: "one\ntwo\n" },
    ]);
    expect(result).toEqual({ status: "covered", capturedRunId: "captured" });
  });

  test("trims the longest captured prefix and reparents the replay", () => {
    const identity = captureSourceIdentity(["pi", "machine", "conversation", "/session.jsonl"]);
    const result = deriveReplayBody(body({
      jsonl: "one\ntwo\nthree\n",
      source_identity: identity,
      from_offset: 5,
      to_offset: 19,
      jsonl_sha256: sha256("one\ntwo\nthree\n"),
    }), [
      { runId: "short", jsonl: "one\n" },
      { runId: "long", jsonl: "one\ntwo\n" },
    ]);
    expect(result.status).toBe("suffix");
    if (result.status !== "suffix") throw new Error("expected suffix replay");
    expect(result.body.jsonl).toBe("three\n");
    expect(result.body.parent_run_id).toBe("long");
    expect(result.body.from_offset).toBe(13);
    expect(result.body.to_offset).toBe(19);
    expect(result.body.jsonl_sha256).toBe(sha256("three\n"));
    expect(result.body.tags).toContain("prefix-trimmed");
  });

  test("uses a deterministic new Run ID when an accepted prefix has the source Run ID", () => {
    const source = body({ run_id: "a".repeat(26), jsonl: "one\ntwo\n" });
    const first = deriveReplayBody(source, [
      { runId: source.run_id, jsonl: "one\n", jsonlSha256: sha256("one\n") },
    ]);
    const second = deriveReplayBody(source, [
      { runId: source.run_id, jsonl: "one\n", jsonlSha256: sha256("one\n") },
    ]);
    expect(first.status).toBe("suffix");
    expect(second.status).toBe("suffix");
    if (first.status !== "suffix" || second.status !== "suffix") {
      throw new Error("expected suffix replay");
    }
    expect(first.body.run_id).not.toBe(source.run_id);
    expect(first.body.run_id).toBe(second.body.run_id);
    expect(first.body.parent_run_id).toBe(source.run_id);
  });

  test("replay key binds run id, source bytes, and transformed bytes", () => {
    expect(replayKey("run", "source", "replay")).toBe("run:source:replay");
  });

  test("catalog integrity rejects changed metadata", () => {
    const original = entry("a".repeat(26), "one\n", 1);
    expect(catalogEntryMatches(original, { ...original })).toBe(true);
    expect(catalogEntryMatches(original, { ...original, bodySha256: "changed" })).toBe(false);
    expect(catalogEntryMatches(original, { ...original, mtimeMs: 2 })).toBe(false);
  });

  test("outbox boundary rejects root and parent paths", () => {
    expect(isPathInside("/outbox", "/outbox/a.json", "a.json")).toBe(true);
    expect(isPathInside("/outbox", "/outbox", "")).toBe(false);
    expect(isPathInside("/outbox", "/escape.json", "../escape.json")).toBe(false);
  });

  test("captured sibling must match its indexed SHA", () => {
    const digest = sha256("captured\n");
    expect(verifiedCapturedSibling("run", "captured\n", digest)).toEqual({
      runId: "run",
      jsonl: "captured\n",
      jsonlSha256: digest,
    });
    expect(() => verifiedCapturedSibling("run", "captured\n", undefined)).toThrow(
      "missing indexed jsonl_sha256",
    );
    expect(() => verifiedCapturedSibling("run", "changed\n", digest)).toThrow(
      "raw/indexed SHA mismatch",
    );
  });

  test("failed checkpoints require a reviewed explicit retry", () => {
    expect(canAttemptReplay(undefined, "run", undefined)).toBe(true);
    expect(canAttemptReplay("failed", "run", undefined)).toBe(false);
    expect(canAttemptReplay("failed", "run", "run")).toBe(true);
    expect(canAttemptReplay("inflight", "run", "run")).toBe(false);
    expect(canAttemptReplay("accepted", "run", "run")).toBe(false);
    expect(canAttemptReplay("indexed", "run", "run")).toBe(false);
  });
});
