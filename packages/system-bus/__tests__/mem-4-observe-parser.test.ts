import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function loadObserveParserModule() {
  return import("../src/inngest/functions/observe-parser.ts");
}

describe("MEM-4: observe-parser exports", () => {
  test("AC-1 and AC-2: module exports ObserverOutput type contract and parseObserverOutput function", async () => {
    const mod = await loadObserveParserModule();

    expect("parseObserverOutput" in mod).toBe(true);
    expect(typeof mod.parseObserverOutput).toBe("function");

    const tempDir = await mkdtemp(join(tmpdir(), "mem-4-typecheck-"));
    try {
      const typecheckFile = join(tempDir, "observer-output-shape.ts");
      await writeFile(
        typecheckFile,
        `import type { ObserverOutput } from "${join(process.cwd(), "src/inngest/functions/observe-parser.ts")}";

const sample: ObserverOutput = {
  observations: "note",
  currentTask: null,
  suggestedResponse: null,
  parsed: true,
};

const observations: string = sample.observations;
const currentTask: string | null = sample.currentTask;
const suggestedResponse: string | null = sample.suggestedResponse;
const parsed: boolean = sample.parsed;

void observations;
void currentTask;
void suggestedResponse;
void parsed;
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

describe("MEM-4: parseObserverOutput behavior", () => {
  test("AC-3: extracts and trims XML tag content when present", async () => {
    const { parseObserverOutput } = await loadObserveParserModule();

    const raw = `\n<observations>\n  🔴 Database connection retries exceeded\n</observations>\n<current-task>  Investigate Redis timeout handling  </current-task>\n<suggested-response>  I found repeated Redis connection failures and can add retry backoff.  </suggested-response>\n`;

    const result = parseObserverOutput(raw);

    expect(result).toEqual({
      observations: "🔴 Database connection retries exceeded",
      currentTask: "Investigate Redis timeout handling",
      suggestedResponse: "I found repeated Redis connection failures and can add retry backoff.",
      parsed: true,
    });
  });

  test("AC-3: observations tag alone still parses and leaves optional fields null", async () => {
    const { parseObserverOutput } = await loadObserveParserModule();

    const raw = `<observations>  🟡 Memory usage growing over several loops  </observations>`;

    const result = parseObserverOutput(raw);

    expect(result).toEqual({
      observations: "🟡 Memory usage growing over several loops",
      currentTask: null,
      suggestedResponse: null,
      parsed: true,
    });
  });

  test("AC-4: falls back to emoji-marker detection when no XML tags are present", async () => {
    const { parseObserverOutput } = await loadObserveParserModule();

    const raw = `🔴 Critical: deploy failed\n🟡 Warning: queue lag rising\n🟢 Info: logs archived`;

    const result = parseObserverOutput(raw);

    expect(result).toEqual({
      observations: raw,
      currentTask: null,
      suggestedResponse: null,
      parsed: true,
    });
  });

  test("AC-5: returns raw input with parsed=false for unrecognized text", async () => {
    const { parseObserverOutput } = await loadObserveParserModule();

    const raw = "status unknown maybe later";
    const result = parseObserverOutput(raw);

    expect(result).toEqual({
      observations: raw,
      currentTask: null,
      suggestedResponse: null,
      parsed: false,
    });
  });

  test("AC-6: returns empty observations with parsed=false for empty or whitespace input", async () => {
    const { parseObserverOutput } = await loadObserveParserModule();

    expect(parseObserverOutput("")).toEqual({
      observations: "",
      currentTask: null,
      suggestedResponse: null,
      parsed: false,
    });

    expect(parseObserverOutput("   \n\t  ")).toEqual({
      observations: "",
      currentTask: null,
      suggestedResponse: null,
      parsed: false,
    });
  });
});

describe("MEM-4: TypeScript compile gate", () => {
  test(
    "AC-7: bunx tsc --noEmit succeeds",
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
