import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __retroWriterTestUtils,
  passesRetroNoiseBar,
  runRetroWriter,
} from "./retro-writer";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "retro-writer-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("retro writer noise bar", () => {
  test("skips short efforts with no decision ledger entries", () => {
    expect(passesRetroNoiseBar({ stepCount: 0, ledgerEntryCount: 0 })).toBeFalse();
    expect(passesRetroNoiseBar({ stepCount: 2, ledgerEntryCount: 0 })).toBeFalse();
  });

  test("accepts multi-step efforts or any real decision ledger entry", () => {
    expect(passesRetroNoiseBar({ stepCount: 3, ledgerEntryCount: 0 })).toBeTrue();
    expect(passesRetroNoiseBar({ stepCount: 1, ledgerEntryCount: 1 })).toBeTrue();
  });

  test("extracts only the Result section from a step", () => {
    const result = __retroWriterTestUtils.resultSection([
      "# Example",
      "",
      "## Step",
      "Do the work.",
      "",
      "## Result (2026-07-17)",
      "Changed the durable rule.",
      "",
      "## Notes",
      "Not part of the result.",
    ].join("\n"));

    expect(result).toBe("Changed the durable rule.");
  });
});

describe("runRetroWriter", () => {
  test("emits a warn and does not infer when the noise bar fails", async () => {
    const directory = await makeTemporaryDirectory();
    const briefPath = join(directory, "small-brief.svx");
    const outputPath = join(directory, "retro.svx");
    await writeFile(briefPath, [
      "---",
      'title: "Small effort"',
      'type: "brief"',
      'status: "done"',
      "---",
      "",
      "# Small effort",
      "",
      "No decision ledger.",
    ].join("\n"));

    const events: Array<Record<string, unknown>> = [];
    const result = await runRetroWriter(
      { brief_path: briefPath, requested_by: "test" },
      {
        outputPath,
        infer: async () => {
          throw new Error("inference must not run");
        },
        emit: async (event) => {
          events.push(event as unknown as Record<string, unknown>);
          return { stored: true };
        },
      },
    );

    expect(result.status).toBe("skipped");
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("memory.retro.skipped");
    expect(events[0]?.level).toBe("warn");
    expect(await Bun.file(outputPath).exists()).toBeFalse();
  });

  test("reads linked Result sections and writes the fixed retro template", async () => {
    const directory = await makeTemporaryDirectory();
    const briefPath = join(directory, "real-brief.svx");
    const stepPath = join(directory, "ship-step.svx");
    const outputPath = join(directory, "retro.svx");
    await writeFile(stepPath, [
      "---",
      'title: "Ship the rule"',
      'type: "step"',
      'status: "closed"',
      "---",
      "",
      "# Ship the rule",
      "",
      "## Result",
      "The hook now emits one typed event.",
      "",
      "## Notes",
      "This text must not reach the condenser.",
    ].join("\n"));
    await writeFile(briefPath, [
      "---",
      'title: "Real effort"',
      'type: "brief"',
      'status: "done"',
      "---",
      "",
      "# Real effort",
      "",
      "## Decision ledger",
      "",
      "- [Ship the rule](./ship-step.svx) — done.",
    ].join("\n"));

    let prompt = "";
    const result = await runRetroWriter(
      { brief_path: briefPath, session_id: "session-1", requested_by: "test" },
      {
        outputPath,
        now: () => new Date("2026-07-17T20:00:00Z"),
        infer: async (input) => {
          prompt = input;
          return {
            text: "",
            data: {
              what_happened: "The effort added the typed close-out path.",
              what_it_means: "Hooks now have one stable transport into the writer.",
              durable_behavior: "Effort close now produces a guarded, source-grounded retro.",
            },
          };
        },
        emit: async () => ({ stored: true }),
      },
    );

    expect(result.status).toBe("written");
    expect(prompt).toContain("The hook now emits one typed event.");
    expect(prompt).not.toContain("This text must not reach the condenser.");

    const output = await readFile(outputPath, "utf8");
    expect(output).toContain('type: "resource"');
    expect(output).toContain('privacy: "private"');
    expect(output).toContain("# What happened");
    expect(output).toContain("# What it means");
    expect(output).toContain("# What changed durable behavior");
    expect(output).toContain("# Receipts");
    expect(output).toContain("file://");
  });
});
