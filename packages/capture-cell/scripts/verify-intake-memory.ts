import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createIntakeHandler } from "../src/intake/server";
import { blobPath, openIntake, owedPage } from "../src/intake/store";
import { MAX_INTAKE_BYTES } from "../src/intake/stream";

// Run explicitly in a fresh 256 MiB, zero-swap cgroup. Both the actual HTTP
// sender and server live inside that limit, not only a JS heap-size setting.
const rootParent = process.env.CAPTURE_TEST_ROOT;
if (!rootParent || process.platform !== "linux")
  throw new Error("CAPTURE_TEST_ROOT on disk and Linux cgroup v2 required");
const cgroup = readFileSync("/proc/self/cgroup", "utf8").trim().split(":").at(-1)!;
const cgroupRoot = join("/sys/fs/cgroup", cgroup);
assert.equal(readFileSync(join(cgroupRoot, "memory.max"), "utf8").trim(), String(256 * 1024 ** 2));
assert.equal(readFileSync(join(cgroupRoot, "memory.swap.max"), "utf8").trim(), "0");
const root = mkdtempSync(join(rootParent, "intake-memory-"));
const store = openIntake(root);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: MAX_INTAKE_BYTES,
  fetch: createIntakeHandler({
    store,
    ingestToken: "synthetic-ingest",
    pullToken: "synthetic-pull",
    principal: { user_id: "test" },
  }),
});
const fillerBytes = 250 * 1024 ** 2;
const chunk = Buffer.from("x".repeat(64 * 1024));
const linePrefix = '{"type":"user","message":{"role":"user","content":"';
const lineSuffix = '"}}\n';
let remaining = fillerBytes;
let phase: "prefix" | "fill" | "end" = "prefix";
const body = new ReadableStream<Uint8Array>({
  pull(controller) {
    if (phase === "prefix") {
      controller.enqueue(
        Buffer.from(
          `{"run_id":"large","machine_id":"synthetic","agent_runtime":"pi","jsonl":"${JSON.stringify(linePrefix).slice(1, -1)}`,
        ),
      );
      phase = "fill";
    } else if (remaining) {
      const count = Math.min(chunk.length, remaining);
      remaining -= count;
      controller.enqueue(chunk.subarray(0, count));
    } else {
      phase = "end";
      controller.enqueue(Buffer.from(`${JSON.stringify(lineSuffix).slice(1, -1)}"}`));
      controller.close();
    }
  },
});
try {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
    method: "POST",
    headers: { authorization: "Bearer synthetic-ingest" },
    body,
  });
  assert.equal(response.status, 202, await response.text());
  const rows = owedPage(store);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0]!.metadata.jsonl_bytes,
    fillerBytes + Buffer.byteLength(linePrefix + lineSuffix),
  );
  assert.equal(statSync(blobPath(store, rows[0]!.id)).size, rows[0]!.metadata.jsonl_bytes);
  assert.equal(existsSync(join(root, "sessions.db")), false);
  const peak = Number(readFileSync(join(cgroupRoot, "memory.peak"), "utf8"));
  assert(peak <= 256 * 1024 ** 2, "cgroup peak exceeded 256 MiB");
  console.log(
    JSON.stringify({
      ok: true,
      decoded_bytes: rows[0]!.metadata.jsonl_bytes,
      memory_max: 256 * 1024 ** 2,
      swap_max: 0,
      cgroup_peak_bytes: peak,
      process_max_rss_kib: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  await server.stop(true);
  store.close();
  rmSync(root, { recursive: true, force: true });
}
