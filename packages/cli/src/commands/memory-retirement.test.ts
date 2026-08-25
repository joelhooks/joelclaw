import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI_ENTRY = resolve(process.cwd(), "packages/cli/src/cli.ts");

describe("retired direct memory writes", () => {
  test("fails nonzero without invoking Inngest", () => {
    const result = spawnSync(
      "bun",
      ["run", CLI_ENTRY, "memory", "write", "retirement-fixture", "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          INNGEST_EVENT_KEY: "must-not-be-used",
          INNGEST_BASE_URL: "http://127.0.0.1:1",
        },
      },
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      error?: { code?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("MEMORY_WRITE_RETIRED");
    expect(result.stdout).not.toContain("run_id");
  });
});
