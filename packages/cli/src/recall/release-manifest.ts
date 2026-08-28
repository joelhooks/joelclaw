/**
 * Release manifest binding for the flowing recall read boundary.
 *
 * Directory containment proves only that a file sits under a path this machine
 * calls a release root. It does not prove the file is the pinned immutable
 * release. Anyone who can write inside that root can drop an arbitrary
 * executable there, and the adapter would trust it for exactly the invariants
 * the local wire mirror deliberately does not re-derive.
 *
 * So the executable is bound to a manifest instead. The manifest sits beside
 * the release, names the exact `joelclaw-memory` commit the artifacts were
 * built from, lists each artifact by release-relative path, kind, and sha-256,
 * and is itself refused when it or the artifact carries any writable bit. The
 * digest is recomputed here on every resolution — a manifest that merely
 * asserts a digest proves nothing.
 *
 * Manifest v2 is a new explicit contract. There is no v1 to fall back to, and
 * an unmanifested artifact is refused rather than grandfathered.
 *
 * A manifest alone still only proves internal consistency: anyone who can write
 * a release directory can write both the artifact and a manifest that describes
 * it. So the digest of the one artifact this consumer will execute is anchored
 * here, in consumer code, and required in addition to the manifest. A
 * self-manifested arbitrary standalone satisfies the manifest and still fails.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Schema } from "effect";

export const FLOWING_RELEASE_MANIFEST_SCHEMA_VERSION = 2 as const;

/** Beside the release, at the top of the release directory. */
export const FLOWING_RELEASE_MANIFEST_FILENAME = "flowing-memory-release.v2.json";

/**
 * The pinned semantic source revision. The local wire mirror in
 * `flowing-envelope.ts` mirrors exactly this commit, so an artifact built from
 * any other commit is a contract mismatch even when it runs.
 */
export const PINNED_MEMORY_COMMIT = "034f082bf8bcdc5aad0d88f1d8cb5e2e05304ff0";

/**
 * The only artifact kind this boundary will execute. A wrapper script, a
 * `bun run` shim, or a dev build can change behaviour without changing the
 * pinned commit; a standalone compiled artifact cannot.
 */
export const REQUIRED_ARTIFACT_KIND = "standalone";

/**
 * The sha-256 of the one standalone read artifact this consumer will execute,
 * built directly from `joelclaw-memory` at {@link PINNED_MEMORY_COMMIT} at the
 * final basename. Anchored in consumer code so no on-disk document can vouch
 * for a different build.
 */
export const PINNED_READ_ARTIFACT_SHA256 =
  "20757b24554a938a9adaeb75ed8a4a08271a7dca9d68e02ddee80392d66397e4";

const CommitSchema = Schema.String.pipe(
  Schema.filter((value) => /^[a-f0-9]{40}$/u.test(value), {
    message: () => "expected a full lowercase git commit SHA",
  }),
);

const DigestSchema = Schema.String.pipe(
  Schema.filter((value) => /^[a-f0-9]{64}$/u.test(value), {
    message: () => "expected a lowercase sha-256 hex digest",
  }),
);

/** Release-relative only. No absolute path, no parent traversal, no root escape. */
const ArtifactPathSchema = Schema.String.pipe(
  Schema.filter(
    (value) =>
      value.length > 0 &&
      value.length <= 512 &&
      !isAbsolute(value) &&
      !value.split(/[\\/]/u).includes("..") &&
      !value.startsWith("~"),
    { message: () => "expected a release-relative artifact path" },
  ),
);

const ArtifactSchema = Schema.Struct({
  kind: Schema.Literal("standalone", "script", "library"),
  path: ArtifactPathSchema,
  sha256: DigestSchema,
});

export const FlowingReleaseManifestV2Schema = Schema.Struct({
  _tag: Schema.Literal("FlowingMemoryReleaseManifestV2"),
  artifacts: Schema.Array(ArtifactSchema).pipe(
    Schema.filter(
      (artifacts) =>
        artifacts.length > 0 &&
        artifacts.length <= 64 &&
        new Set(artifacts.map((artifact) => artifact.path)).size === artifacts.length,
      { message: () => "expected a non-empty set of uniquely pathed artifacts" },
    ),
  ),
  memoryCommit: CommitSchema,
  releasedAt: Schema.optional(
    Schema.String.pipe(
      Schema.filter((value) => Number.isFinite(Date.parse(value)), {
        message: () => "expected an ISO-8601 instant",
      }),
    ),
  ),
  schemaVersion: Schema.Literal(FLOWING_RELEASE_MANIFEST_SCHEMA_VERSION),
});

export type FlowingReleaseManifestV2 = Schema.Schema.Type<typeof FlowingReleaseManifestV2Schema>;

const decodeManifest = Schema.decodeUnknownEither(FlowingReleaseManifestV2Schema);

/**
 * Device and inode. A path is a name, and a name can be pointed at a different
 * file without the name changing. Identity is what says the thing behind the
 * name is still the thing that was verified — a rebuilt file with byte-identical
 * contents is a different inode, and so is a directory swapped in by rename.
 */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface ReleaseArtifactBinding {
  readonly manifestPath: string;
  readonly releaseDir: string;
  readonly artifactPath: string;
  readonly memoryCommit: string;
  readonly artifactIdentity: FileIdentity;
  readonly manifestIdentity: FileIdentity;
  readonly releaseDirIdentity: FileIdentity;
  /** The digest recomputed from the file at resolution time. */
  readonly sha256: string;
  /**
   * The anchored digest this binding was required to match. Carried so the
   * pre-execution re-check re-proves the same anchor without re-reading config.
   */
  readonly expectedSha256: string;
}

export type ReleaseVerification =
  | { readonly ok: true; readonly binding: ReleaseArtifactBinding }
  | { readonly ok: false; readonly reason: ReleaseRejectionReason; readonly message: string };

export type ReleaseRejectionReason =
  | "release-dir-unreadable"
  | "release-dir-writable"
  | "release-dir-replaced"
  | "manifest-missing"
  | "manifest-unreadable"
  | "manifest-writable"
  | "manifest-invalid"
  | "manifest-wrong-commit"
  | "artifact-unmanifested"
  | "artifact-wrong-kind"
  | "artifact-writable"
  | "artifact-digest-mismatch"
  | "artifact-not-pinned-build"
  | "artifact-replaced"
  | "manifest-replaced"
  | "artifact-unreadable";

/**
 * Any writable bit at all, owner included. An owner-writable release is still a
 * release that can be swapped between verification and execution by whatever
 * runs as that owner, which is exactly this process.
 */
export function isWritable(mode: number): boolean {
  return (mode & 0o222) !== 0;
}

function identityOf(stat: { dev: number; ino: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The release directory is the immediate child of the trusted root that
 * contains the artifact. A deeper artifact still belongs to that release, so
 * its manifest entry is the path relative to that directory.
 */
export function releaseDirectoryFor(
  resolvedRoot: string,
  resolvedArtifact: string,
): string | undefined {
  const rel = relative(resolvedRoot, resolvedArtifact);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const [first] = rel.split(sep);
  if (!first || first === "." || first === rel) return undefined;
  return join(resolvedRoot, first);
}

/**
 * Proves the artifact is the pinned release. Every rejection is a refusal to
 * execute, never a downgrade to a weaker check.
 */
export function verifyReleaseArtifact(input: {
  readonly resolvedRoot: string;
  readonly resolvedArtifact: string;
  readonly expectedCommit?: string;
  /** Test seam only. Production always requires the anchored artifact digest. */
  readonly expectedArtifactSha256?: string;
}): ReleaseVerification {
  const expectedCommit = input.expectedCommit ?? PINNED_MEMORY_COMMIT;
  const expectedSha256 = input.expectedArtifactSha256 ?? PINNED_READ_ARTIFACT_SHA256;
  const releaseDir = releaseDirectoryFor(input.resolvedRoot, input.resolvedArtifact);
  if (!releaseDir) {
    return {
      ok: false,
      reason: "manifest-missing",
      message: "flowing recall read executable is not inside a versioned release directory",
    };
  }

  // The directory is part of the artifact's identity. A writable release
  // directory means the artifact and the manifest inside it can be unlinked and
  // replaced wholesale, which no per-file mode check would notice.
  let releaseDirIdentity: FileIdentity;
  try {
    const stat = statSync(releaseDir);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        reason: "release-dir-unreadable",
        message: "flowing recall release directory is not a directory",
      };
    }
    if (isWritable(stat.mode)) {
      return {
        ok: false,
        reason: "release-dir-writable",
        message: "flowing recall release directory is writable",
      };
    }
    releaseDirIdentity = identityOf(stat);
  } catch {
    return {
      ok: false,
      reason: "release-dir-unreadable",
      message: "flowing recall release directory could not be inspected",
    };
  }

  const manifestPath = join(releaseDir, FLOWING_RELEASE_MANIFEST_FILENAME);
  let manifestMode: number;
  let manifestIdentity: FileIdentity;
  try {
    const stat = statSync(manifestPath);
    if (!stat.isFile()) {
      return {
        ok: false,
        reason: "manifest-missing",
        message: "flowing recall release manifest is not a regular file",
      };
    }
    manifestMode = stat.mode;
    manifestIdentity = identityOf(stat);
  } catch {
    return {
      ok: false,
      reason: "manifest-missing",
      message: "flowing recall release manifest is absent beside the release",
    };
  }

  if (isWritable(manifestMode)) {
    return {
      ok: false,
      reason: "manifest-writable",
      message: "flowing recall release manifest is writable",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return {
      ok: false,
      reason: "manifest-unreadable",
      message: "flowing recall release manifest is not one readable JSON document",
    };
  }

  const decoded = decodeManifest(parsed);
  if (decoded._tag === "Left") {
    return {
      ok: false,
      reason: "manifest-invalid",
      message: "flowing recall release manifest does not satisfy the v2 manifest contract",
    };
  }
  const manifest = decoded.right;

  if (manifest.memoryCommit !== expectedCommit) {
    return {
      ok: false,
      reason: "manifest-wrong-commit",
      message:
        "flowing recall release manifest names a different joelclaw-memory commit than the pinned wire contract",
    };
  }

  const relativePath = relative(releaseDir, input.resolvedArtifact);
  const artifact = manifest.artifacts.find(
    (entry) => entry.path.split(/[\\/]/u).join(sep) === relativePath,
  );
  if (!artifact) {
    return {
      ok: false,
      reason: "artifact-unmanifested",
      message: "flowing recall read executable is not listed in the release manifest",
    };
  }

  if (artifact.kind !== REQUIRED_ARTIFACT_KIND) {
    return {
      ok: false,
      reason: "artifact-wrong-kind",
      message: "flowing recall read executable is not a standalone release artifact",
    };
  }

  let artifactMode: number;
  let artifactIdentity: FileIdentity;
  try {
    const stat = statSync(input.resolvedArtifact);
    if (!stat.isFile()) {
      return {
        ok: false,
        reason: "artifact-unreadable",
        message: "flowing recall read executable is not a regular file",
      };
    }
    artifactMode = stat.mode;
    artifactIdentity = identityOf(stat);
  } catch {
    return {
      ok: false,
      reason: "artifact-unreadable",
      message: "flowing recall read executable could not be inspected",
    };
  }
  if (isWritable(artifactMode)) {
    return {
      ok: false,
      reason: "artifact-writable",
      message: "flowing recall read executable is writable",
    };
  }

  let digest: string;
  try {
    digest = sha256File(input.resolvedArtifact);
  } catch {
    return {
      ok: false,
      reason: "artifact-unreadable",
      message: "flowing recall read executable could not be read for digest verification",
    };
  }
  if (digest !== artifact.sha256) {
    return {
      ok: false,
      reason: "artifact-digest-mismatch",
      message: "flowing recall read executable does not match its manifest digest",
    };
  }

  // The manifest is on-disk data. It can be authored by whoever authored the
  // artifact beside it, so agreeing with itself is not evidence. The anchored
  // digest is the only claim in this check that an attacker with write access
  // to the release root cannot also author.
  if (digest !== expectedSha256) {
    return {
      ok: false,
      reason: "artifact-not-pinned-build",
      message: "flowing recall read executable is not the anchored pinned read artifact",
    };
  }

  return {
    ok: true,
    binding: {
      manifestPath,
      releaseDir,
      artifactPath: input.resolvedArtifact,
      memoryCommit: manifest.memoryCommit,
      artifactIdentity,
      manifestIdentity,
      releaseDirIdentity,
      sha256: digest,
      expectedSha256,
    },
  };
}

export type ReleaseRecheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ReleaseRejectionReason; readonly message: string };

interface RecheckTarget {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly kind: "directory" | "file";
  readonly writableReason: ReleaseRejectionReason;
  readonly replacedReason: ReleaseRejectionReason;
  readonly unreadableReason: ReleaseRejectionReason;
  readonly label: string;
}

/**
 * Re-proves an already verified binding at a later moment. Resolution, the
 * credential lease, and the spawn are three separate moments, and a file can be
 * swapped between any two of them. Each one runs this, so a swap costs the
 * attacker a refusal rather than a secret or an execution.
 *
 * Mode and digest alone are not enough: an attacker who unlinks the artifact and
 * writes a new one keeps the path, can restore the mode, and — for the release
 * directory, which has no digest — changes nothing this check could otherwise
 * see. Device and inode are what carry over from the verified moment.
 */
export function reverifyReleaseBinding(binding: ReleaseArtifactBinding): ReleaseRecheck {
  const targets: readonly RecheckTarget[] = [
    {
      path: binding.releaseDir,
      identity: binding.releaseDirIdentity,
      kind: "directory",
      writableReason: "release-dir-writable",
      replacedReason: "release-dir-replaced",
      unreadableReason: "release-dir-unreadable",
      label: "flowing recall release directory",
    },
    {
      path: binding.manifestPath,
      identity: binding.manifestIdentity,
      kind: "file",
      writableReason: "manifest-writable",
      replacedReason: "manifest-replaced",
      unreadableReason: "manifest-missing",
      label: "flowing recall release manifest",
    },
    {
      path: binding.artifactPath,
      identity: binding.artifactIdentity,
      kind: "file",
      writableReason: "artifact-writable",
      replacedReason: "artifact-replaced",
      unreadableReason: "artifact-unreadable",
      label: "flowing recall read executable",
    },
  ];

  for (const target of targets) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(target.path);
    } catch {
      return {
        ok: false,
        reason: target.unreadableReason,
        message: `${target.label} disappeared after verification`,
      };
    }
    const rightKind = target.kind === "directory" ? stat.isDirectory() : stat.isFile();
    if (!rightKind) {
      return {
        ok: false,
        reason: target.replacedReason,
        message: `${target.label} changed kind after verification`,
      };
    }
    if (!sameIdentity(identityOf(stat), target.identity)) {
      return {
        ok: false,
        reason: target.replacedReason,
        message: `${target.label} was replaced after verification`,
      };
    }
    if (isWritable(stat.mode)) {
      return {
        ok: false,
        reason: target.writableReason,
        message: `${target.label} became writable after verification`,
      };
    }
  }

  let digest: string;
  try {
    digest = sha256File(binding.artifactPath);
  } catch {
    return {
      ok: false,
      reason: "artifact-unreadable",
      message: "flowing recall read executable could not be re-read for digest verification",
    };
  }

  if (digest !== binding.sha256 || digest !== binding.expectedSha256) {
    return {
      ok: false,
      reason: "artifact-not-pinned-build",
      message: "flowing recall read executable changed after verification",
    };
  }

  return { ok: true };
}
