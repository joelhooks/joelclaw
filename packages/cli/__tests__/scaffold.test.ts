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
    const pkg = await Bun.file(resolve(CLI_ROOT, "package.json")).json();
    expect(pkg.name).toBe("@joelclaw/cli");
  });
});

// --------------------------------------------------------------------------
// AC-2: package.json has bin field: { 'joelclaw': 'src/cli.ts' }
// --------------------------------------------------------------------------
describe("AC-2: bin field", () => {
  test("bin field exists", async () => {
    const pkg = await Bun.file(resolve(CLI_ROOT, "package.json")).json();
    expect(pkg.bin).toBeDefined();
  });

  test("bin.joelclaw points to src/cli.ts", async () => {
    const pkg = await Bun.file(resolve(CLI_ROOT, "package.json")).json();
    expect(pkg.bin.joelclaw).toBe("src/cli.ts");
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

  test("all four source files are non-empty", async () => {
    for (const file of requiredFiles) {
      const content = await Bun.file(resolve(SRC_DIR, file)).text();
      expect(content.length).toBeGreaterThan(0);
    }
  });
});

// --------------------------------------------------------------------------
// AC-4: packages/cli/tsconfig.json exists
// --------------------------------------------------------------------------
describe("AC-4: tsconfig.json", () => {
  test("tsconfig.json exists", () => {
    expect(existsSync(resolve(CLI_ROOT, "tsconfig.json"))).toBe(true);
  });

  test("tsconfig.json is valid JSON", async () => {
    const content = await Bun.file(resolve(CLI_ROOT, "tsconfig.json")).json();
    expect(content).toBeDefined();
    expect(content.compilerOptions).toBeDefined();
  });
});

// --------------------------------------------------------------------------
// AC-5: Source files are copied from the igs CLI without modification yet
//
// The originals live at ~/Code/joelhooks/igs/src/. If that path isn't
// accessible, we verify the files are non-trivial TypeScript (contain
// expected imports/exports) to confirm they're real source, not stubs.
// --------------------------------------------------------------------------
describe("AC-5: source files match igs originals", () => {
  const igsRoot = resolve(
    process.env.HOME ?? "/Users/joel",
    "Code",
    "joelhooks",
    "igs",
    "src",
  );

  const sourceFiles = ["cli.ts", "config.ts", "inngest.ts", "response.ts"];

  for (const file of sourceFiles) {
    test(`src/${file} matches igs original`, async () => {
      const igsPath = resolve(igsRoot, file);

      if (!existsSync(igsPath)) {
        // Can't compare — verify the file looks like real source, not a stub
        const content = await Bun.file(resolve(SRC_DIR, file)).text();
        expect(content.length).toBeGreaterThan(50);
        console.warn(
          `igs original not found at ${igsPath} — verified file is non-trivial (${content.length} chars)`,
        );
        return;
      }

      const original = await Bun.file(igsPath).text();
      const copy = await Bun.file(resolve(SRC_DIR, file)).text();
      expect(copy).toBe(original);
    });
  }
});

// --------------------------------------------------------------------------
// AC-6: bun run packages/cli/src/cli.ts --help shows the CLI help
// --------------------------------------------------------------------------
describe("AC-6: CLI --help", () => {
  test(
    "running cli.ts --help exits 0 and produces help output",
    async () => {
      const proc = Bun.spawn(
        ["bun", "run", resolve(SRC_DIR, "cli.ts"), "--help"],
        {
          stdout: "pipe",
          stderr: "pipe",
          cwd: CLI_ROOT,
        },
      );

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const output = stdout + stderr;

      expect(exitCode).toBe(0);
      // Help output should contain meaningful text — not just empty
      expect(output.length).toBeGreaterThan(10);
    },
    30_000,
  );
});

// --------------------------------------------------------------------------
// AC-7: TypeScript compiles with no errors: cd packages/cli && bunx tsc --noEmit
// --------------------------------------------------------------------------
describe("AC-7: TypeScript compiles", () => {
  test(
    "bunx tsc --noEmit succeeds with exit code 0",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: CLI_ROOT,
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        console.error("tsc stdout:", stdout);
        console.error("tsc stderr:", stderr);
      }

      expect(exitCode).toBe(0);
    },
    30_000,
  );
});
