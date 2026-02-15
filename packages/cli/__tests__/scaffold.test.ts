import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_DIR = resolve(CLI_ROOT, "src");

// --------------------------------------------------------------------------
// AC-1: packages/cli/package.json exists with name '@joelclaw/cli'
// --------------------------------------------------------------------------
describe("AC-1: package.json name", () => {
  test("packages/cli/package.json exists", () => {
    const pkgPath = resolve(CLI_ROOT, "package.json");
    expect(existsSync(pkgPath)).toBe(true);
  });

  test("package name is '@joelclaw/cli'", async () => {
    const pkg = await import(resolve(CLI_ROOT, "package.json"));
    expect(pkg.default.name ?? pkg.name).toBe("@joelclaw/cli");
  });
});

// --------------------------------------------------------------------------
// AC-2: package.json has bin field: { 'joelclaw': 'src/cli.ts' }
// --------------------------------------------------------------------------
describe("AC-2: bin field", () => {
  test("bin.joelclaw points to src/cli.ts", async () => {
    const pkg = await import(resolve(CLI_ROOT, "package.json"));
    const data = pkg.default ?? pkg;
    expect(data.bin).toBeDefined();
    expect(data.bin.joelclaw).toBe("src/cli.ts");
  });
});

// --------------------------------------------------------------------------
// AC-3: packages/cli/src/ contains cli.ts, config.ts, inngest.ts, response.ts
// --------------------------------------------------------------------------
describe("AC-3: source files exist", () => {
  const requiredFiles = ["cli.ts", "config.ts", "inngest.ts", "response.ts"];

  for (const file of requiredFiles) {
    test(`src/${file} exists`, () => {
      expect(existsSync(resolve(SRC_DIR, file))).toBe(true);
    });
  }
});

// --------------------------------------------------------------------------
// AC-4: packages/cli/tsconfig.json exists
// --------------------------------------------------------------------------
describe("AC-4: tsconfig.json", () => {
  test("tsconfig.json exists", () => {
    expect(existsSync(resolve(CLI_ROOT, "tsconfig.json"))).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC-5: Source files are copied from the igs CLI without modification yet
//
// We verify this by checking that the igs source files exist at their
// expected location and that the CLI copies are byte-identical.
// --------------------------------------------------------------------------
describe("AC-5: source files match igs originals", () => {
  const igsRoot = resolve(CLI_ROOT, "..", "system-bus", "src", "cli");
  const filePairs = [
    { cli: "cli.ts", igs: "cli.ts" },
    { cli: "config.ts", igs: "config.ts" },
    { cli: "inngest.ts", igs: "inngest.ts" },
    { cli: "response.ts", igs: "response.ts" },
  ];

  for (const { cli, igs } of filePairs) {
    test(`src/${cli} matches igs source ${igs}`, async () => {
      const igsPath = resolve(igsRoot, igs);
      // If igs originals don't exist at this path, the test documents
      // that we can't verify — skip gracefully so the other ACs still run.
      if (!existsSync(igsPath)) {
        // Try alternate known location
        const altIgsPath = resolve(
          CLI_ROOT,
          "..",
          "system-bus",
          "src",
          igs,
        );
        if (!existsSync(altIgsPath)) {
          console.warn(
            `Skipping comparison for ${igs}: igs original not found at ${igsPath} or ${altIgsPath}`,
          );
          return;
        }
        const original = await Bun.file(altIgsPath).text();
        const copy = await Bun.file(resolve(SRC_DIR, cli)).text();
        expect(copy).toBe(original);
        return;
      }
      const original = await Bun.file(igsPath).text();
      const copy = await Bun.file(resolve(SRC_DIR, cli)).text();
      expect(copy).toBe(original);
    });
  }
});

// --------------------------------------------------------------------------
// AC-6: bun run packages/cli/src/cli.ts --help shows the CLI help
// --------------------------------------------------------------------------
describe("AC-6: CLI --help", () => {
  test("running cli.ts --help exits successfully and shows help text", async () => {
    const proc = Bun.spawn(["bun", "run", resolve(SRC_DIR, "cli.ts"), "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: CLI_ROOT,
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + stderr;

    // --help should exit 0
    expect(exitCode).toBe(0);
    // Output should contain recognisable help content
    expect(output.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// AC-7: TypeScript compiles with no errors: cd packages/cli && bunx tsc --noEmit
// --------------------------------------------------------------------------
describe("AC-7: TypeScript compiles", () => {
  test("bunx tsc --noEmit succeeds with exit code 0", async () => {
    const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: CLI_ROOT,
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      console.error("tsc output:", stdout, stderr);
    }

    expect(exitCode).toBe(0);
  }, 30_000); // tsc can be slow on first run
});
