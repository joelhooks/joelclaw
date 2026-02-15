import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function loadObserveParserModule() {
  return import("../src/inngest/functions/observe-parser.ts");
}

describe("NUUM-3: ObserverOutput segments contract", () => {
  test("AC-1: ObserverOutput includes segments: DistilledSegment[]", async () => {
    const mod = await loadObserveParserModule();

    expect("parseObserverOutput" in mod).toBe(true);
    expect(typeof mod.parseObserverOutput).toBe("function");

    const tempDir = await mkdtemp(join(tmpdir(), "nuum-3-typecheck-"));
    try {
      const typecheckFile = join(tempDir, "observer-output-segments.ts");
      await writeFile(
        typecheckFile,
        `import { parseObserverOutput } from "${join(process.cwd(), "src/inngest/functions/observe-parser.ts")}";
import type { DistilledSegment, ObserverOutput } from "${join(process.cwd(), "src/inngest/functions/observe-parser.ts")}";

const output: ObserverOutput = parseObserverOutput("<observations><segment><narrative>n</narrative><facts>- one</facts></segment></observations>");
const segments: DistilledSegment[] = output.segments;

void segments;
void output;
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

describe("NUUM-3: parseObserverOutput segment behavior", () => {
  test("AC-2 and AC-4: parses segments from <observations> while preserving observations/currentTask/suggestedResponse", async () => {
    const { parseObserverOutput } = await loadObserveParserModule();

    const input = `
<observations>
Date: 2026-02-15
<segment>
  <narrative>
    Queue processing degraded after deploy.
  </narrative>
  <facts>
    - Retry attempts spiked
    - Worker restarts increased
  </facts>
</segment>
<segment>
  <narrative>Service stabilized after rollback.</narrative>
  <facts>
    - Error rate dropped
    - Throughput normalized
  </facts>
</segment>
</observations>
<current-task>
  Stabilize queue processing
</current-task>
<suggested-response>
  I identified the bottleneck and will apply the fix next.
</suggested-response>
`;

    const result = parseObserverOutput(input);

    expect(result.parsed).toBe(true);
    expect(result.currentTask).toBe("Stabilize queue processing");
    expect(result.suggestedResponse).toBe(
      "I identified the bottleneck and will apply the fix next."
    );
    expect(result.observations).toContain("Date: 2026-02-15");
    expect(result.observations).toContain("<segment>");
    expect(result.segments).toEqual([
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

  test("AC-3 and AC-4: returns empty segments for flat-format observations while preserving backward-compatible fields", async () => {
    const { parseObserverOutput } = await loadObserveParserModule();

    const input = [
      "Date: 2026-02-15",
      "🔴 Critical blocker remains",
      "🟡 Follow-up needed",
      "🟢 Informational note",
    ].join("\n");

    expect(parseObserverOutput(input)).toEqual({
      observations: input,
      currentTask: null,
      suggestedResponse: null,
      parsed: true,
      segments: [],
    });
  });
});

describe("NUUM-3: TypeScript compile gate", () => {
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
