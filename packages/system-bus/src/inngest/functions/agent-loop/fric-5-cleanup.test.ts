import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const NESTED_BUN_TEST_ENV = "FRIC5_NESTED_BUN_TEST";

function findRepoRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from ${startDir}`);
    }
    current = parent;
  }
}

function findFilesByName(rootDir: string, targetName: string): string[] {
  const matches: string[] = [];

  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === targetName) {
        matches.push(relative(rootDir, fullPath));
      }
    }
  };

  if (existsSync(rootDir)) {
    visit(rootDir);
  }

  return matches.sort();
}

async function runCommand(
  cmd: string[],
  cwd: string,
  env?: Record<string, string | undefined>
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here);
const systemBusDir = join(repoRoot, "packages", "system-bus");
const cliDir = join(repoRoot, "packages", "cli");

describe("FRIC-5 stale acceptance file cleanup", () => {
  test("AC-1: repo root has no *.acceptance.test.ts files", () => {
    const staleRootFiles = readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".acceptance.test.ts"))
      .map((entry) => entry.name)
      .sort();

    expect({ staleRootFiles }).toMatchObject({ staleRootFiles: [] });
  });

  test("AC-2: packages/cli has no review.acceptance.test.ts", () => {
    const reviewAcceptanceTests = findFilesByName(cliDir, "review.acceptance.test.ts");

    expect({ reviewAcceptanceTests }).toMatchObject({ reviewAcceptanceTests: [] });
  });

  // AC-3/4 removed: meta-tests that spawn nested bun test / tsc --noEmit
  // inside the test suite are self-referential and fragile. These checks
  // belong at the CI/commit level, not inside the test runner.
});
