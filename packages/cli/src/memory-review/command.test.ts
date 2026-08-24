import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve(process.cwd(), "packages/cli/src/cli.ts");

test("CLI registers memory review", () => {
  const process = spawnSync("bun", ["run", cli, "memory", "--help"], { encoding: "utf8" });
  expect(process.status).toBe(0);
  expect(process.stdout).toContain("review");
  expect(process.stdout).toContain("Review recent fleet memory");
});

test("CLI rejects an unsafe scope before invoking remote collectors", () => {
  const process = spawnSync(
    "bun",
    ["run", cli, "memory", "review", "--project", "joelhooks.joelclaw;touch-pwned"],
    { encoding: "utf8" },
  );
  expect(process.status).toBe(1);
  const envelope = JSON.parse(process.stdout) as { error?: { code?: string } };
  expect(envelope.error?.code).toBe("MEMORY_REVIEW_SCOPE_INVALID");
});

test("CLI rejects an invalid review window before collecting sources", () => {
  const process = spawnSync("bun", ["run", cli, "memory", "review", "--since", "tomorrow"], {
    encoding: "utf8",
  });
  expect(process.status).toBe(1);
  const envelope = JSON.parse(process.stdout) as {
    ok: boolean;
    command: string;
    error?: { code?: string };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.command).toBe("joelclaw memory review");
  expect(envelope.error?.code).toBe("MEMORY_REVIEW_INVALID");
});
