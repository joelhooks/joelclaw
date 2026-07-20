import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSourceIdentity, sha256 } from "./lib/capture-outbox-replay";

let fixtureRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

describe("canonical capture replay planner", () => {
  test("queries captured siblings within the deterministic source identity", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "capture-replay-fixture-"));
    const outbox = join(fixtureRoot, "outbox");
    mkdirSync(outbox);
    const identity = captureSourceIdentity(["pi", "machine", "conversation", "/session.jsonl"]);
    const jsonl = "one\n";
    writeFileSync(
      join(outbox, `${"a".repeat(26)}.json`),
      JSON.stringify({
        run_id: "a".repeat(26),
        agent_runtime: "pi",
        conversation_id: "conversation",
        started_at: 1_700_000_000_000,
        source_identity: identity,
        from_offset: 0,
        to_offset: Buffer.byteLength(jsonl),
        jsonl_sha256: sha256(jsonl),
        jsonl,
      }),
    );
    const requestedUrls: URL[] = [];
    const typesense = Bun.serve({
      port: 0,
      fetch(request) {
        requestedUrls.push(new URL(request.url));
        return Response.json({ found: 0, hits: [] });
      },
    });
    const catalog = join(fixtureRoot, "catalog.json");
    const receipt = join(fixtureRoot, "receipt.json");

    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "scripts/replay-capture-outbox.ts",
          "--outbox",
          outbox,
          "--catalog",
          catalog,
          "--receipt",
          receipt,
          "--typesense-url",
          `http://127.0.0.1:${typesense.port}`,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: fixtureRoot, TYPESENSE_API_KEY: "fixture-key" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(0);
      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0].searchParams.get("filter_by")).toContain(
        `source_identity:=\`${identity}\``,
      );
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({
        ok: true,
        readOnly: true,
        representatives: 1,
      });
    } finally {
      typesense.stop(true);
    }
  });
});
