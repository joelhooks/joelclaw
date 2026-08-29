import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  FLOWING_RELEASE_MANIFEST_FILENAME,
  FLOWING_RELEASE_MANIFEST_SCHEMA_VERSION,
  type FlowingReleaseManifestV2,
  REQUIRED_ARTIFACT_KIND,
  sha256File,
  verifyReleaseArtifact,
} from "../packages/cli/src/recall/release-manifest";

const ARTIFACT_FILENAME = "joelclaw-memory";
const FULL_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DEFAULT_TRUSTED_RELEASE_ROOT = join(homedir(), ".joelclaw", "flowing-memory", "releases");
const BUILD_ARGUMENT_NAMES = ["--checkout", "--expected-commit", "--output-dir"] as const;
type BuildArgumentName = (typeof BUILD_ARGUMENT_NAMES)[number];

export interface FlowingReleaseBuildInput {
  readonly checkoutPath: string;
  readonly expectedCommit: string;
  readonly outputDirectory: string;
}

export interface FlowingReleaseCompilerInput {
  readonly artifactPath: string;
  readonly checkoutPath: string;
}

export type FlowingReleaseCompiler = (input: FlowingReleaseCompilerInput) => void;

export interface FlowingReleaseLockInput {
  readonly artifactPath: string;
  readonly manifestPath: string;
  readonly outputDirectory: string;
}

export type FlowingReleaseLocker = (input: FlowingReleaseLockInput) => void;

export interface FlowingReleaseBuildDependencies {
  /** Boundary seam for tests. Production uses the standalone Bun compiler below. */
  readonly compile?: FlowingReleaseCompiler;
  /** Mutation-test seam. A no-op must fail the mandatory self-verification. */
  readonly lockRelease?: FlowingReleaseLocker;
}

export interface FlowingReleaseBuildReceipt {
  readonly _tag: "FlowingReleaseBuildReceiptV1";
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly checkoutPath: string;
  readonly manifestPath: string;
  readonly memoryCommit: string;
  readonly outputDirectory: string;
}

function errorCode(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, "code") : undefined;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function isBuildArgumentName(value: string | undefined): value is BuildArgumentName {
  return value === "--checkout" || value === "--expected-commit" || value === "--output-dir";
}

function inspectCheckout(checkoutPath: string, expectedCommit: string): void {
  const commitCheck = Bun.spawnSync({
    cmd: ["git", "cat-file", "-e", `${expectedCommit}^{commit}`],
    cwd: checkoutPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (commitCheck.exitCode !== 0) {
    throw new Error("expected commit is not valid in checkout");
  }

  const head = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--verify", "HEAD^{commit}"],
    cwd: checkoutPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (head.exitCode !== 0) throw new Error("checkout HEAD is not a valid commit");
  const actualCommit = head.stdout.toString().trim();
  if (!FULL_COMMIT_PATTERN.test(actualCommit)) {
    throw new Error("checkout HEAD did not resolve to a full lowercase git commit SHA");
  }
  if (actualCommit !== expectedCommit) {
    throw new Error(`checkout commit mismatch: expected ${expectedCommit}, got ${actualCommit}`);
  }

  const status = Bun.spawnSync({
    cmd: ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    cwd: checkoutPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (status.exitCode !== 0) throw new Error("checkout status could not be inspected");
  if (status.stdout.byteLength > 0) throw new Error("checkout is dirty");
}

export function flowingReleaseCompileCommand(artifactPath: string): string[] {
  return ["bun", "build", "apps/cli/src/cli.ts", "--compile", "--outfile", artifactPath];
}

const defaultCompiler: FlowingReleaseCompiler = ({ artifactPath, checkoutPath }) => {
  const compiled = Bun.spawnSync({
    cmd: flowingReleaseCompileCommand(artifactPath),
    cwd: checkoutPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (compiled.exitCode !== 0) {
    throw new Error(`standalone compiler failed with exit code ${compiled.exitCode}`);
  }
};

const defaultLocker: FlowingReleaseLocker = ({ artifactPath, manifestPath, outputDirectory }) => {
  chmodSync(artifactPath, 0o555);
  chmodSync(manifestPath, 0o444);
  chmodSync(outputDirectory, 0o555);
};

function resolveCheckout(path: string): string {
  let checkoutPath: string;
  try {
    checkoutPath = realpathSync(path);
  } catch {
    throw new Error("checkout path does not exist or is not accessible");
  }
  if (!statSync(checkoutPath).isDirectory()) throw new Error("checkout path is not a directory");
  return checkoutPath;
}

function resolveNewOutputDirectory(path: string, checkoutPath: string): string {
  const requestedOutput = resolve(path);
  const trustedReleaseRoot = resolve(DEFAULT_TRUSTED_RELEASE_ROOT);
  if (isInsideOrEqual(trustedReleaseRoot, requestedOutput)) {
    throw new Error("output path must not be inside the trusted release root");
  }
  if (pathExists(requestedOutput)) throw new Error("output path already exists");

  let outputParent: string;
  try {
    outputParent = realpathSync(dirname(requestedOutput));
  } catch {
    throw new Error("output parent does not exist or is not accessible");
  }
  if (!statSync(outputParent).isDirectory()) throw new Error("output parent is not a directory");

  const outputDirectory = join(outputParent, basename(requestedOutput));
  if (isInsideOrEqual(trustedReleaseRoot, outputDirectory)) {
    throw new Error("output path must not be inside the trusted release root");
  }
  if (pathExists(outputDirectory)) throw new Error("output path already exists");
  if (isInsideOrEqual(checkoutPath, outputDirectory)) {
    throw new Error("output path must be outside the source checkout");
  }
  return outputDirectory;
}

function assertStandaloneArtifact(path: string): void {
  let artifact;
  try {
    artifact = lstatSync(path);
  } catch {
    throw new Error("compiler did not create the standalone artifact");
  }
  if (!artifact.isFile()) throw new Error("compiler did not create a regular standalone artifact");
}

function removeFailedOutput(outputDirectory: string): void {
  try {
    chmodSync(outputDirectory, 0o700);
  } catch {
    // The directory may not have survived the failed build.
  }
  rmSync(outputDirectory, { recursive: true, force: true });
}

export function buildFlowingRelease(
  input: FlowingReleaseBuildInput,
  dependencies: FlowingReleaseBuildDependencies = {},
): FlowingReleaseBuildReceipt {
  if (!FULL_COMMIT_PATTERN.test(input.expectedCommit)) {
    throw new Error("expected commit must be a full lowercase git commit SHA");
  }

  const checkoutPath = resolveCheckout(input.checkoutPath);
  const outputDirectory = resolveNewOutputDirectory(input.outputDirectory, checkoutPath);
  inspectCheckout(checkoutPath, input.expectedCommit);

  try {
    mkdirSync(outputDirectory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new Error("output path already exists");
    throw error;
  }

  try {
    const artifactPath = join(outputDirectory, ARTIFACT_FILENAME);
    const manifestPath = join(outputDirectory, FLOWING_RELEASE_MANIFEST_FILENAME);
    const compile = dependencies.compile ?? defaultCompiler;
    compile({ artifactPath, checkoutPath });
    assertStandaloneArtifact(artifactPath);
    inspectCheckout(checkoutPath, input.expectedCommit);

    const artifactSha256 = sha256File(artifactPath);
    const manifest: FlowingReleaseManifestV2 = {
      _tag: "FlowingMemoryReleaseManifestV2",
      artifacts: [
        {
          kind: REQUIRED_ARTIFACT_KIND,
          path: ARTIFACT_FILENAME,
          sha256: artifactSha256,
        },
      ],
      memoryCommit: input.expectedCommit,
      schemaVersion: FLOWING_RELEASE_MANIFEST_SCHEMA_VERSION,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    const lockRelease = dependencies.lockRelease ?? defaultLocker;
    lockRelease({ artifactPath, manifestPath, outputDirectory });

    const verified = verifyReleaseArtifact({
      resolvedRoot: dirname(outputDirectory),
      resolvedArtifact: artifactPath,
      expectedCommit: input.expectedCommit,
      expectedArtifactSha256: artifactSha256,
    });
    if (!verified.ok) {
      throw new Error(`release self-verification failed: ${verified.reason}`);
    }

    return {
      _tag: "FlowingReleaseBuildReceiptV1",
      artifactPath,
      artifactSha256,
      checkoutPath,
      manifestPath,
      memoryCommit: input.expectedCommit,
      outputDirectory,
    };
  } catch (error) {
    removeFailedOutput(outputDirectory);
    throw error;
  }
}

export function parseFlowingReleaseBuildArgs(args: readonly string[]): FlowingReleaseBuildInput {
  const values = new Map<BuildArgumentName, string>();

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!isBuildArgumentName(name)) {
      throw new Error(`unexpected argument: ${name ?? "<missing>"}`);
    }
    if (values.has(name)) throw new Error(`duplicate argument: ${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for argument: ${name}`);
    values.set(name, value);
    index += 1;
  }

  const requiredValue = (name: BuildArgumentName): string => {
    const value = values.get(name);
    if (!value) throw new Error(`missing required argument: ${name}`);
    return value;
  };

  return {
    checkoutPath: requiredValue("--checkout"),
    expectedCommit: requiredValue("--expected-commit"),
    outputDirectory: requiredValue("--output-dir"),
  };
}

function main(): void {
  try {
    const receipt = buildFlowingRelease(parseFlowingReleaseBuildArgs(Bun.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "flowing release build failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
