import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./lib/capture-outbox-replay";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function fixture(archiveStatus: "covered" | "full" = "covered") {
  root = mkdtempSync(join(tmpdir(), "capture-quarantine-"));
  const outbox = join(root, "outbox");
  const quarantine = join(root, "quarantine");
  const catalog = join(root, "catalog.json");
  const receipt = join(root, "receipt.json");
  mkdirSync(outbox);
  const file = "pending.json";
  const jsonl = "one\n";
  const raw = JSON.stringify({
    run_id: "a".repeat(26),
    agent_runtime: "pi",
    started_at: 1_700_000_000_000,
    jsonl,
  });
  writeFileSync(join(outbox, file), raw);
  writeFileSync(
    catalog,
    JSON.stringify({
      schemaVersion: 2,
      sourceCount: 1,
      representatives: 1,
      entries: [
        {
          path: `/frozen/${file}`,
          file,
          fileBytes: Buffer.byteLength(raw),
          mtimeMs: 1,
          runId: "a".repeat(26),
          runtime: "pi",
          startedAt: 1_700_000_000_000,
          jsonlChars: jsonl.length,
          jsonlBytes: Buffer.byteLength(jsonl),
          jsonlSha256: sha256(jsonl),
          bodySha256: sha256(raw),
          disposition: "representative",
          archiveStatus,
        },
      ],
    }),
  );
  return { outbox, quarantine, catalog, receipt, file };
}

async function run(
  paths: ReturnType<typeof fixture>,
  execute = false,
): Promise<{ exitCode: number; receipt?: Record<string, unknown> }> {
  const child = Bun.spawn(
    [
      process.execPath,
      "scripts/quarantine-capture-outbox.ts",
      "--catalog",
      paths.catalog,
      "--outbox",
      paths.outbox,
      "--quarantine",
      paths.quarantine,
      "--receipt",
      paths.receipt,
      ...(execute ? ["--execute"] : []),
    ],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await child.exited;
  return {
    exitCode,
    receipt: existsSync(paths.receipt)
      ? (JSON.parse(readFileSync(paths.receipt, "utf8")) as Record<string, unknown>)
      : undefined,
  };
}

describe("capture outbox quarantine", () => {
  test("checks first and moves an exact reviewed file only with --execute", async () => {
    const paths = fixture();
    expect(await run(paths)).toMatchObject({
      exitCode: 0,
      receipt: { mode: "check", matched: 1, moved: 0, skipped: 0 },
    });
    expect(existsSync(join(paths.outbox, paths.file))).toBe(true);

    expect(await run(paths, true)).toMatchObject({
      exitCode: 0,
      receipt: { mode: "execute", matched: 0, moved: 1, skipped: 0 },
    });
    expect(existsSync(join(paths.outbox, paths.file))).toBe(false);
    expect(existsSync(join(paths.quarantine, paths.file))).toBe(true);
  });

  test("refuses a catalog with an uncovered representative", async () => {
    const paths = fixture("full");
    expect((await run(paths)).exitCode).not.toBe(0);
    expect(existsSync(join(paths.outbox, paths.file))).toBe(true);
  });

  test("skips a live file whose bytes changed after the frozen copy", async () => {
    const paths = fixture();
    writeFileSync(join(paths.outbox, paths.file), "changed bytes");
    expect(await run(paths, true)).toMatchObject({
      exitCode: 0,
      receipt: { moved: 0, skipped: 1 },
    });
    expect(existsSync(join(paths.outbox, paths.file))).toBe(true);
  });
});
