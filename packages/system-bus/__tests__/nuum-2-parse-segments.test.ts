import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function loadObserveParserModule() {
  return import("../src/inngest/functions/observe-parser.ts");
}

describe("NUUM-2: observe-parser segment exports", () => {
  test("AC-1 and AC-2: exports DistilledSegment type contract and parseSegments function signature", async () => {
    const mod = await loadObserveParserModule();

    expect("parseSegments" in mod).toBe(true);
    expect(typeof mod.parseSegments).toBe("function");

    const tempDir = await mkdtemp(join(tmpdir(), "nuum-2-typecheck-"));
    try {
      const typecheckFile = join(tempDir, "distilled-segment-shape.ts");
      await writeFile(
        typecheckFile,
        `import { parseSegments } from "${join(process.cwd(), "src/inngest/functions/observe-parser.ts")}";
import type { DistilledSegment } from "${join(process.cwd(), "src/inngest/functions/observe-parser.ts")}";

const sample: DistilledSegment = {
  narrative: "Found a retry bottleneck.",
  facts: ["Redis timeout increases", "Queue depth recovered after restart"],
};

const parsed: DistilledSegment[] = parseSegments("<segment><narrative>n</narrative><facts>- one</facts></segment>");

const narrative: string = sample.narrative;
const facts: string[] = sample.facts;

void parsed;
void narrative;
void facts;
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

describe("NUUM-2: parseSegments behavior", () => {
  test("AC-3: extracts narrative and trimmed fact bullets from segment blocks", async () => {
    const { parseSegments } = await loadObserveParserModule();

    const observations = `
Date: 2026-02-15
<segment>
  <narrative>
    Queue processing degraded after deploy.
  </narrative>
  <facts>
    -   Retry attempts spiked
    - Worker restarts increased
  </facts>
</segment>
<segment>
  <narrative>Service stabilized after rollback.</narrative>
  <facts>
    - Error rate dropped
    -   Throughput normalized
  </facts>
</segment>
`;

    expect(parseSegments(observations)).toEqual([
      {
        narrative: "Queue processing degraded after deploy.",
        facts: ["Retry attempts spiked", "Worker restarts increased"],
      },
      {
        narrative: "Service stabilized after rollback.",
        facts: ["Error rate dropped", "Throughput normalized"],
      },
    ]);
  });

  test("AC-4: returns empty array when no segment tags are present", async () => {
    const { parseSegments } = await loadObserveParserModule();

    const observations = `
<observations>
  🔴 Build step failed during dependency install
</observations>
`;

    expect(parseSegments(observations)).toEqual([]);
  });
});

describe("NUUM-2: TypeScript compile gate", () => {
  test(
    "AC-5: bunx tsc --noEmit succeeds",
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
