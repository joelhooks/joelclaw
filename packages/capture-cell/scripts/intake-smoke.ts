import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const env: Record<string, string> = {};
for (const line of readFileSync(
  process.env.CAPTURE_INTAKE_ENV_FILE ?? "/etc/capture-intake/env",
  "utf8",
).split("\n")) {
  if (!line.trim() || line.trimStart().startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator < 1) throw new Error("invalid intake env file");
  env[line.slice(0, separator).trim()] = line
    .slice(separator + 1)
    .trim()
    .replace(/^["']|["']$/gu, "");
}
assert(env.CAPTURE_INTAKE_TOKEN, "ingest token missing");
const url = `http://127.0.0.1:${Number(env.CAPTURE_CELL_PORT ?? 3114)}`;
const health = await fetch(`${url}/health`);
assert.equal(health.status, 200);
assert.equal(((await health.json()) as { ok: boolean }).ok, true);
const run_id = `smoke-${randomUUID()}`;
const body = JSON.stringify({
  run_id,
  machine_id: "intake-smoke",
  tags: ["synthetic:intake-smoke"],
  agent_runtime: "pi",
  started_at: Date.now(),
  jsonl: `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Synthetic intake smoke test" } })}\n`,
});
let original: string | undefined;
for (let attempt = 0; attempt < 2; attempt++) {
  const response: Response = await fetch(`${url}/api/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CAPTURE_INTAKE_TOKEN}`,
      "content-type": "application/json",
    },
    body,
  });
  assert.equal(response.status, 202);
  const ack = (await response.json()) as { id: string; run_id: string };
  assert.equal(ack.run_id, run_id);
  if (original) assert.equal(ack.id, original);
  else original = ack.id;
}
console.log(JSON.stringify({ health: 200, post: 202, duplicate: 202, run_id }));
