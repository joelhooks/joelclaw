import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function loadObserveParserModule() {
  return import("../src/inngest/functions/observe-parser.ts");
}

describe("NUUM-5: formatSegmentsForLog export contract", () => {
  test("AC-1: observe-parser.ts exports formatSegmentsForLog", async () => {
    const mod = await loadObserveParserModule();

    expect("formatSegmentsForLog" in mod).toBe(true);
    expect(typeof mod.formatSegmentsForLog).toBe("function");
  });

  test("AC-1: exported function type accepts DistilledSegment[] and returns string", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "nuum-5-typecheck-"));
    try {
      const typecheckFile = join(tempDir, "format-segments-for-log-shape.ts");
      await writeFile(
        typecheckFile,
        `import { formatSegmentsForLog } from "${join(process.cwd(), "src/inngest/functions/observe-parser.ts")}";
import type { DistilledSegment } from "${join(process.cwd(), "src/inngest/functions/observe-parser.ts")}";

const segments: DistilledSegment[] = [
  {
    narrative: "Queue recovered after retry strategy update.",
    facts: ["Retry storm stopped", "Latency returned to baseline"],
  },
];

const rendered: string = formatSegmentsForLog(segments);

void rendered;
`
      );

      const proc = Bun.spawn(
        [
          "bunx",
          "tsc",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--moduleResolution",
          "bundler",
          "--allowImportingTsExtensions",
          "--module",
          "Preserve",
          "--target",
          "ESNext",
          typecheckFile,
        ],
        {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("NUUM-5: formatSegmentsForLog markdown rendering", () => {
  test("AC-2, AC-3, AC-5: renders italic narratives, bullet facts, and blank-line-separated segments", async () => {
    const { formatSegmentsForLog } = await loadObserveParserModule();

    const output = formatSegmentsForLog([
      {
        narrative: "Queue recovered after retry strategy update.",
        facts: ["Retry storm stopped", "Latency returned to baseline"],
      },
      {
        narrative: "Backfill job finished without errors.",
        facts: ["Processed 124 records", "No manual intervention needed"],
      },
    ]);

    expect(output).toBe(
      [
        "*Queue recovered after retry strategy update.*",
        "- Retry storm stopped",
        "- Latency returned to baseline",
        "",
        "*Backfill job finished without errors.*",
        "- Processed 124 records",
        "- No manual intervention needed",
      ].join("\n")
    );
  });

  test("AC-4: returns empty string for empty segments array", async () => {
    const { formatSegmentsForLog } = await loadObserveParserModule();

    expect(formatSegmentsForLog([])).toBe("");
  });
});

describe("NUUM-5: TypeScript compile gate", () => {
  test(
    "AC-6: bunx tsc --noEmit succeeds",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: new URL("..", import.meta.url).pathname,
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    },
    30_000
  );
});
