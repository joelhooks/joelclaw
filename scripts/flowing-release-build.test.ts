import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FLOWING_RELEASE_MANIFEST_FILENAME,
  verifyReleaseArtifact,
} from "../packages/cli/src/recall/release-manifest";
import {
  buildFlowingRelease,
  type FlowingReleaseCompiler,
  flowingReleaseCompileCommand,
  parseFlowingReleaseBuildArgs,
} from "./flowing-release-build";

const ARTIFACT_BYTES = Buffer.from("standalone flowing recall fixture\n", "utf8");
const scratchRoots: string[] = [];

function command(args: readonly string[], cwd?: string): string {
  const result = Bun.spawnSync({
    cmd: [...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `command failed (${result.exitCode}): ${args.join(" ")}\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

function gitFixture(options: { readonly twoCommits?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flowing-release-build-test-")));
  scratchRoots.push(root);
  const checkoutPath = join(root, "checkout");
  const outputDirectory = join(root, "release");
  mkdirSync(checkoutPath);
  command(["git", "init", "--quiet"], checkoutPath);
  command(["git", "config", "user.name", "Flowing Release Test"], checkoutPath);
  command(["git", "config", "user.email", "flowing-release-test@example.invalid"], checkoutPath);
  writeFileSync(join(checkoutPath, "source.txt"), "first\n");
  command(["git", "add", "source.txt"], checkoutPath);
  command(["git", "commit", "--quiet", "-m", "first"], checkoutPath);
  const firstCommit = command(["git", "rev-parse", "HEAD"], checkoutPath);

  if (options.twoCommits) {
    writeFileSync(join(checkoutPath, "source.txt"), "second\n");
    command(["git", "add", "source.txt"], checkoutPath);
    command(["git", "commit", "--quiet", "-m", "second"], checkoutPath);
  }

  return {
    root,
    checkoutPath,
    outputDirectory,
    firstCommit,
    headCommit: command(["git", "rev-parse", "HEAD"], checkoutPath),
  };
}

const fakeCompiler: FlowingReleaseCompiler = ({ artifactPath }) => {
  writeFileSync(artifactPath, ARTIFACT_BYTES, { flag: "wx", mode: 0o755 });
};

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    const releaseDirectory = join(root, "release");
    if (existsSync(releaseDirectory)) chmodSync(releaseDirectory, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("flowing release build arguments", () => {
  test("requires explicit checkout, full commit, and output directory flags", () => {
    expect(
      parseFlowingReleaseBuildArgs([
        "--checkout",
        "/tmp/memory",
        "--expected-commit",
        "a".repeat(40),
        "--output-dir",
        "/tmp/release",
      ]),
    ).toEqual({
      checkoutPath: "/tmp/memory",
      expectedCommit: "a".repeat(40),
      outputDirectory: "/tmp/release",
    });

    expect(() => parseFlowingReleaseBuildArgs(["--checkout", "/tmp/memory"])).toThrow(
      "missing required argument: --expected-commit",
    );
    expect(() =>
      parseFlowingReleaseBuildArgs([
        "--checkout",
        "/tmp/memory",
        "--expected-commit",
        "a".repeat(40),
        "--output-dir",
        "/tmp/release",
        "surprise",
      ]),
    ).toThrow("unexpected argument: surprise");
  });

  test("uses the established standalone Bun compile command", () => {
    expect(flowingReleaseCompileCommand("/tmp/release/joelclaw-memory")).toEqual([
      "bun",
      "build",
      "apps/cli/src/cli.ts",
      "--compile",
      "--outfile",
      "/tmp/release/joelclaw-memory",
    ]);
  });
});

describe("flowing release checkout refusals", () => {
  test("refuses dirty checkouts before creating output", () => {
    const fixture = gitFixture();
    writeFileSync(join(fixture.checkoutPath, "dirty.txt"), "untracked\n");

    expect(() =>
      buildFlowingRelease(
        {
          checkoutPath: fixture.checkoutPath,
          expectedCommit: fixture.headCommit,
          outputDirectory: fixture.outputDirectory,
        },
        { compile: fakeCompiler },
      ),
    ).toThrow("checkout is dirty");
    expect(existsSync(fixture.outputDirectory)).toBe(false);
  });

  test("refuses malformed, unknown, and mismatched commits", () => {
    const malformed = gitFixture();
    expect(() =>
      buildFlowingRelease(
        {
          checkoutPath: malformed.checkoutPath,
          expectedCommit: "main",
          outputDirectory: malformed.outputDirectory,
        },
        { compile: fakeCompiler },
      ),
    ).toThrow("expected commit must be a full lowercase git commit SHA");

    const unknown = gitFixture();
    expect(() =>
      buildFlowingRelease(
        {
          checkoutPath: unknown.checkoutPath,
          expectedCommit: "f".repeat(40),
          outputDirectory: unknown.outputDirectory,
        },
        { compile: fakeCompiler },
      ),
    ).toThrow("expected commit is not valid in checkout");

    const mismatch = gitFixture({ twoCommits: true });
    expect(() =>
      buildFlowingRelease(
        {
          checkoutPath: mismatch.checkoutPath,
          expectedCommit: mismatch.firstCommit,
          outputDirectory: mismatch.outputDirectory,
        },
        { compile: fakeCompiler },
      ),
    ).toThrow(
      `checkout commit mismatch: expected ${mismatch.firstCommit}, got ${mismatch.headCommit}`,
    );
  });

  test("never overwrites an existing output path", () => {
    const fixture = gitFixture();
    mkdirSync(fixture.outputDirectory);
    let compiled = false;

    expect(() =>
      buildFlowingRelease(
        {
          checkoutPath: fixture.checkoutPath,
          expectedCommit: fixture.headCommit,
          outputDirectory: fixture.outputDirectory,
        },
        {
          compile: (input) => {
            compiled = true;
            fakeCompiler(input);
          },
        },
      ),
    ).toThrow("output path already exists");
    expect(compiled).toBe(false);
  });

  test("refuses to build inside the trusted release root", () => {
    const fixture = gitFixture();
    const trustedOutput = join(
      homedir(),
      ".joelclaw",
      "flowing-memory",
      "releases",
      `cycle05-test-${process.pid}`,
    );
    expect(existsSync(trustedOutput)).toBe(false);

    expect(() =>
      buildFlowingRelease(
        {
          checkoutPath: fixture.checkoutPath,
          expectedCommit: fixture.headCommit,
          outputDirectory: trustedOutput,
        },
        { compile: fakeCompiler },
      ),
    ).toThrow("output path must not be inside the trusted release root");
    expect(existsSync(trustedOutput)).toBe(false);
  });
});

describe("flowing release output", () => {
  test("builds a schema-valid locked standalone and self-verifies its bytes", () => {
    const fixture = gitFixture();
    const receipt = buildFlowingRelease(
      {
        checkoutPath: fixture.checkoutPath,
        expectedCommit: fixture.headCommit,
        outputDirectory: fixture.outputDirectory,
      },
      { compile: fakeCompiler },
    );

    expect(receipt).toEqual({
      _tag: "FlowingReleaseBuildReceiptV1",
      artifactPath: join(fixture.outputDirectory, "joelclaw-memory"),
      artifactSha256: createHash("sha256").update(ARTIFACT_BYTES).digest("hex"),
      checkoutPath: fixture.checkoutPath,
      manifestPath: join(fixture.outputDirectory, FLOWING_RELEASE_MANIFEST_FILENAME),
      memoryCommit: fixture.headCommit,
      outputDirectory: fixture.outputDirectory,
    });

    const manifest: unknown = JSON.parse(readFileSync(receipt.manifestPath, "utf8"));
    expect(manifest).toEqual({
      _tag: "FlowingMemoryReleaseManifestV2",
      artifacts: [
        {
          kind: "standalone",
          path: "joelclaw-memory",
          sha256: receipt.artifactSha256,
        },
      ],
      memoryCommit: fixture.headCommit,
      schemaVersion: 2,
    });

    for (const path of [receipt.outputDirectory, receipt.manifestPath, receipt.artifactPath]) {
      expect(statSync(path).mode & 0o222).toBe(0);
    }

    expect(
      verifyReleaseArtifact({
        resolvedRoot: dirname(receipt.outputDirectory),
        resolvedArtifact: receipt.artifactPath,
        expectedCommit: receipt.memoryCommit,
        expectedArtifactSha256: receipt.artifactSha256,
      }).ok,
    ).toBe(true);
  });

  test("self-verification fails when mode locking is removed", () => {
    const fixture = gitFixture();

    expect(() =>
      buildFlowingRelease(
        {
          checkoutPath: fixture.checkoutPath,
          expectedCommit: fixture.headCommit,
          outputDirectory: fixture.outputDirectory,
        },
        { compile: fakeCompiler, lockRelease: () => {} },
      ),
    ).toThrow("release self-verification failed: release-dir-writable");
    expect(existsSync(fixture.outputDirectory)).toBe(false);
  });

  test("rejects a compiler that does not create the standalone artifact", () => {
    const fixture = gitFixture();

    expect(() =>
      buildFlowingRelease(
        {
          checkoutPath: fixture.checkoutPath,
          expectedCommit: fixture.headCommit,
          outputDirectory: fixture.outputDirectory,
        },
        { compile: () => {} },
      ),
    ).toThrow("compiler did not create the standalone artifact");
  });

  test("locks executable bytes rather than trusting a compiler-reported digest", () => {
    const fixture = gitFixture();
    const mutatingCompiler: FlowingReleaseCompiler = ({ artifactPath }) => {
      writeFileSync(artifactPath, ARTIFACT_BYTES, { flag: "wx", mode: 0o755 });
      chmodSync(artifactPath, 0o555);
    };
    const receipt = buildFlowingRelease(
      {
        checkoutPath: fixture.checkoutPath,
        expectedCommit: fixture.headCommit,
        outputDirectory: fixture.outputDirectory,
      },
      { compile: mutatingCompiler },
    );

    expect(receipt.artifactSha256).toBe(
      createHash("sha256").update(readFileSync(receipt.artifactPath)).digest("hex"),
    );
  });
});
