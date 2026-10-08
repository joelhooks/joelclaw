import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createOtelEvent } from "./otel-event";
import { drainOtelOutbox, enqueueOtelOutboxEvent } from "./otel-outbox";

test("OTEL spool refuses agent harness paths before enqueue or cleanup", async () => {
  const protectedDir = join(homedir(), ".pi", "agent", "sessions");
  const event = createOtelEvent({
    level: "info",
    source: "test",
    component: "test",
    action: "test",
    success: true,
  });

  const enqueued = await enqueueOtelOutboxEvent(event, protectedDir);
  const drained = await drainOtelOutbox({ dir: protectedDir });

  expect(enqueued.queued).toBe(false);
  expect(enqueued.error).toContain("protected harness path");
  expect(drained.drained).toBe(0);
  expect(drained.error).toContain("protected harness path");
});

test("event IDs cannot escape the OTEL spool directory", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "otel-outbox-test-"));
  try {
    const event = createOtelEvent({
      id: "../../.pi/agent/sessions/overwrite",
      timestamp: 123,
      level: "info",
      source: "test",
      component: "test",
      action: "test",
      success: true,
    });
    const result = await enqueueOtelOutboxEvent(event, tempRoot);

    expect(result.queued).toBe(true);
    expect(result.path).toBeDefined();
    expect(dirname(result.path!)).toBe(tempRoot);
    expect(basename(result.path!)).toMatch(/^\d{13}-[a-f0-9]{24}\.json$/u);
    expect(await readdir(tempRoot)).toEqual([basename(result.path!)]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
