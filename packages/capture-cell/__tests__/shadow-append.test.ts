import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { classifyFailure, ShadowReadTimeoutError } from "../src/failure";
import { shadowAppend } from "../src/shadow-append";
import {
  createSessionsDb,
  indexWithWriter,
  SOURCE,
  tempRoot,
  turnLines,
  writeCapture,
} from "./fixtures";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function fixture(journalMode: "WAL" | "DELETE" = "WAL") {
  const temp = tempRoot();
  cleanup = temp.cleanup;
  const sessionsDbPath = join(temp.root, "sessions.db");
  createSessionsDb(sessionsDbPath, journalMode);
  return { root: temp.root, sessionsDbPath, options: { sessionsDbPath, readTimeoutMs: 3_000 } };
}

describe("shadow append verdicts", () => {
  test("appended: a new run predicts what the writer then appends, and writes nothing", () => {
    const { root, sessionsDbPath, options } = fixture();
    const payload = writeCapture(root, "run-a", turnLines(5), {
      source_identity: SOURCE,
      from_offset: 0,
    });
    const observation = shadowAppend(payload, options);
    expect(observation.observed).toBe("appended");
    expect(observation.matched).toBeNull();
    expect(observation.format).toBe("claude-code");
    expect(observation.turn_count).toBe(5);
    expect(observation.source_identity).toBe(SOURCE);

    const db = new Database(sessionsDbPath, { readonly: true });
    expect((db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(0);
    db.close();

    const written = indexWithWriter(sessionsDbPath, payload);
    expect(written.status).toBe("appended");
    expect(observation.chunk_count).toBe(written.chunk_count);
  });

  test("already_indexed: the same run is matched by run_id with the stored chunk_count", () => {
    const { root, sessionsDbPath, options } = fixture();
    const payload = writeCapture(root, "run-a", turnLines(4), {
      source_identity: SOURCE,
      from_offset: 0,
    });
    const written = indexWithWriter(sessionsDbPath, payload);
    const observation = shadowAppend(payload, options);
    expect(observation).toMatchObject({
      observed: "already_indexed",
      matched: "run",
      matched_run_id: "run-a",
      chunk_count: written.chunk_count,
      turn_count: 4,
      computed_chunk_count: written.chunk_count,
      computed_turn_count: 4,
      computed_format: "claude-code",
      source_identity: SOURCE,
    });
  });

  test("already_indexed: another run at the same cursor with the same bytes", () => {
    const { root, sessionsDbPath, options } = fixture();
    const jsonl = turnLines(3);
    indexWithWriter(
      sessionsDbPath,
      writeCapture(root, "run-a", jsonl, { source_identity: SOURCE, from_offset: 0 }),
    );
    const second = writeCapture(root, "run-b", jsonl, { source_identity: SOURCE, from_offset: 0 });
    const observation = shadowAppend(second, options);
    expect(observation).toMatchObject({
      observed: "already_indexed",
      matched: "cursor",
      matched_run_id: "run-a",
    });
    expect(indexWithWriter(sessionsDbPath, second).status).toBe("already_indexed");
  });

  test("conflict: an overlapping range at a different start", () => {
    const { root, sessionsDbPath, options } = fixture();
    const first = turnLines(4);
    indexWithWriter(
      sessionsDbPath,
      writeCapture(root, "run-a", first, { source_identity: SOURCE, from_offset: 0 }),
    );
    const overlapping = writeCapture(root, "run-b", turnLines(2, 10), {
      source_identity: SOURCE,
      from_offset: Math.floor(Buffer.byteLength(first) / 2),
    });
    const observation = shadowAppend(overlapping, options);
    expect(observation).toMatchObject({
      observed: "conflict",
      matched: "overlap",
      matched_run_id: "run-a",
    });
    expect(() => indexWithWriter(sessionsDbPath, overlapping)).toThrow(
      "already exists with different JSONL bytes",
    );
  });

  test("conflict: the same run_id with different bytes", () => {
    const { root, sessionsDbPath, options } = fixture();
    indexWithWriter(
      sessionsDbPath,
      writeCapture(root, "run-a", turnLines(2), { source_identity: SOURCE, from_offset: 0 }),
    );
    const changed = writeCapture(root, "run-a", turnLines(3), {
      source_identity: SOURCE,
      from_offset: 0,
    });
    expect(shadowAppend(changed, options)).toMatchObject({
      observed: "conflict",
      matched: "run",
      matched_run_id: "run-a",
    });
  });

  test("a missing blob or a blob with the wrong bytes is a deterministic failure", () => {
    const { root, options } = fixture();
    const payload = writeCapture(root, "run-a", turnLines(2));
    const missing = { ...payload, jsonl_path: join(root, "runs", "gone.jsonl") };
    expect(classifyFailure(catchError(() => shadowAppend(missing, options))).class).toBe(
      "deterministic",
    );
    const wrong = { ...payload, jsonl_sha256: "0".repeat(64) };
    expect(classifyFailure(catchError(() => shadowAppend(wrong, options))).class).toBe(
      "deterministic",
    );
  });
});

describe("shadow read bound", () => {
  test("a locked sessions.db times out within the bound, transient, and holds nothing open", () => {
    const { root, sessionsDbPath } = fixture("DELETE");
    const payload = writeCapture(root, "run-a", turnLines(2), {
      source_identity: SOURCE,
      from_offset: 0,
    });
    const writer = new Database(sessionsDbPath, { readwrite: true });
    writer.exec("BEGIN EXCLUSIVE");
    const started = performance.now();
    const error = catchError(() => shadowAppend(payload, { sessionsDbPath, readTimeoutMs: 150 }));
    const elapsed = performance.now() - started;
    writer.exec("ROLLBACK");
    writer.close();
    expect(error).toBeInstanceOf(ShadowReadTimeoutError);
    expect(classifyFailure(error).class).toBe("transient");
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1_500);
  });

  test("a read that runs over the bound is discarded as a timeout and its connection closed", () => {
    const { root, sessionsDbPath } = fixture("DELETE");
    const payload = writeCapture(root, "run-a", turnLines(2), {
      source_identity: SOURCE,
      from_offset: 0,
    });
    const error = catchError(() =>
      shadowAppend(payload, {
        sessionsDbPath,
        readTimeoutMs: 50,
        duringRead: () => Bun.sleepSync(120),
      }),
    );
    expect(error).toBeInstanceOf(ShadowReadTimeoutError);
    // No read lock survives: an exclusive writer gets in at once.
    const writer = new Database(sessionsDbPath, { readwrite: true });
    writer.exec("PRAGMA busy_timeout = 0");
    writer.exec("BEGIN EXCLUSIVE");
    writer.exec("ROLLBACK");
    writer.close();
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}
