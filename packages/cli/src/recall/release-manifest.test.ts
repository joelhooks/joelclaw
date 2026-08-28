/**
 * The release manifest binding.
 *
 * Every test here places a file inside a trusted release root and proves the
 * boundary still refuses to run it. Containment is the thing being disproved as
 * sufficient, so none of these use an executable outside the root.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveFlowingRecallPortConfig, verifyTrustedExecutable } from "./flowing-port";
import {
  FLOWING_RELEASE_MANIFEST_FILENAME,
  PINNED_MEMORY_COMMIT,
  PINNED_READ_ARTIFACT_SHA256,
  reverifyReleaseBinding,
  verifyReleaseArtifact,
} from "./release-manifest";
import { testRelease, testReleaseSeams, withUnsealedRelease } from "./test-fixtures";

/** Rewrites a read-only fixture file the way an attacker with write access would. */
function swapContents(path: string, body: string, restoreMode: number) {
  chmodSync(path, 0o700);
  writeFileSync(path, body);
  chmodSync(path, restoreMode);
}

function settingsFor(executable: string) {
  return { read_executable: executable, credential_secret_name: "flowing-runtime-url" };
}

describe("a manifested pinned release", () => {
  test("resolves, and carries its commit and recomputed digest into the config", () => {
    const release = testRelease();
    const outcome = resolveFlowingRecallPortConfig({
      settings: settingsFor(release.executable),
      ...testReleaseSeams(release),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.config.release.memoryCommit).toBe(PINNED_MEMORY_COMMIT);
    expect(outcome.config.release.sha256).toBe(release.sha256);
    expect(outcome.config.release.manifestPath).toBe(realpathSync(release.manifestPath));
  });

  test("the pinned commit is the one the local wire mirror was written against", () => {
    expect(PINNED_MEMORY_COMMIT).toBe("601d8c518d3078859b7cdf287a6db52fa8ee9082");
  });
});

describe("containment alone is refused", () => {
  test("an arbitrary 0666 file dropped inside the release root does not run", () => {
    const release = testRelease();
    const planted = join(release.releaseDir, "joelclaw-memory-2");
    withUnsealedRelease(release.releaseDir, () => {
      writeFileSync(planted, "#!/bin/sh\necho pwned\n");
      chmodSync(planted, 0o666);
    });

    const outcome = verifyTrustedExecutable(planted, release.root);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("untrusted-executable");
  });

  test("a world-writable but correctly manifested artifact does not run", () => {
    const release = testRelease({ executableMode: 0o777 });
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("artifact-writable");
  });

  test("a world-writable manifest does not authorise anything", () => {
    const release = testRelease({ manifestMode: 0o666 });
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("manifest-writable");
  });
});

describe("the manifest must name the pinned build", () => {
  test("a release built from another commit is refused", () => {
    const release = testRelease({ memoryCommit: "0".repeat(40) });
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("manifest-wrong-commit");

    // And the whole config resolution refuses it, not just the inner check.
    const resolved = resolveFlowingRecallPortConfig({
      settings: settingsFor(release.executable),
      trustedReleaseRoot: release.root,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe("untrusted-executable");
  });

  test("a digest that does not match the artifact is refused", () => {
    const release = testRelease({ declaredSha256: "b".repeat(64) });
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("artifact-digest-mismatch");
  });

  test("an artifact swapped after the manifest was written is refused", () => {
    const release = testRelease();
    swapContents(release.executable, "#!/bin/sh\necho swapped\n", 0o555);
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("artifact-digest-mismatch");
  });

  test("an unmanifested artifact is refused", () => {
    const release = testRelease({ unmanifested: true });
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("artifact-unmanifested");
  });

  test("a non-standalone artifact kind is refused", () => {
    const release = testRelease({ artifactKind: "script" });
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("artifact-wrong-kind");
  });

  test("an absent manifest is refused rather than grandfathered", () => {
    const release = testRelease();
    withUnsealedRelease(release.releaseDir, () => rmSync(release.manifestPath));
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("manifest-missing");
  });

  test("a manifest that is not the v2 contract is refused", () => {
    const release = testRelease();
    swapContents(
      release.manifestPath,
      JSON.stringify({ _tag: "FlowingMemoryReleaseManifestV1", schemaVersion: 1 }),
      0o444,
    );
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("manifest-invalid");
  });

  test("an artifact directly in the release root has no release directory to trust", () => {
    const release = testRelease();
    const loose = join(release.root, "joelclaw-memory");
    writeFileSync(loose, "#!/bin/sh\nexit 0\n");
    chmodSync(loose, 0o555);
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: loose,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("manifest-missing");
  });

  test("a manifest cannot claim an artifact outside its own release", () => {
    const release = testRelease();
    const otherRelease = join(release.root, "2026-08-23");
    mkdirSync(otherRelease, { recursive: true });
    chmodSync(otherRelease, 0o755);
    const otherManifest = join(otherRelease, FLOWING_RELEASE_MANIFEST_FILENAME);
    writeFileSync(
      otherManifest,
      JSON.stringify({
        _tag: "FlowingMemoryReleaseManifestV2",
        artifacts: [
          {
            kind: "standalone",
            path: "../2026-08-22 build/joelclaw-memory",
            sha256: release.sha256,
          },
        ],
        memoryCommit: PINNED_MEMORY_COMMIT,
        schemaVersion: 2,
      }),
    );
    chmodSync(otherManifest, 0o444);
    const escaping = join(otherRelease, "shim");
    writeFileSync(escaping, "#!/bin/sh\nexit 0\n");
    chmodSync(escaping, 0o555);
    chmodSync(otherRelease, 0o555);

    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: escaping,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The traversal path never decodes, so the manifest itself is invalid.
    expect(outcome.reason).toBe("manifest-invalid");
  });
});

describe("any writable bit is refused, owner included", () => {
  test("an owner-writable artifact does not run", () => {
    const release = testRelease({ executableMode: 0o744 });
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
      ...testReleaseSeams(release),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("artifact-writable");
  });

  test("an owner-writable manifest authorises nothing", () => {
    const release = testRelease({ manifestMode: 0o644 });
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
      ...testReleaseSeams(release),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("manifest-writable");
  });
});

describe("the anchored artifact digest", () => {
  test("is the digest of the standalone read artifact built at the pinned commit", () => {
    expect(PINNED_READ_ARTIFACT_SHA256).toBe(
      "12cba93a879a3c23f1adf16b4dc35a09f0fe36c17ac945262933c88e69c9750d",
    );
  });

  test("a self-manifested arbitrary standalone is refused despite a perfect manifest", () => {
    // The attacker writes both files: an arbitrary standalone and a manifest
    // that names the pinned commit, the standalone kind, and the artifact's own
    // true digest. Everything on disk agrees. Nothing on disk is the pinned
    // build, and the anchored digest is what says so.
    const release = testRelease({ body: "#!/bin/sh\necho pwned\n" });

    const selfConsistent = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
      expectedArtifactSha256: release.sha256,
    });
    expect(selfConsistent.ok).toBe(true);

    const anchored = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
    });
    expect(anchored.ok).toBe(false);
    if (anchored.ok) return;
    expect(anchored.reason).toBe("artifact-not-pinned-build");

    const resolved = resolveFlowingRecallPortConfig({
      settings: settingsFor(release.executable),
      trustedReleaseRoot: release.root,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe("untrusted-executable");
  });
});

describe("the release directory is part of the artifact's identity", () => {
  test("a writable release directory authorises nothing", () => {
    const release = testRelease({ releaseDirMode: 0o755 });
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
      ...testReleaseSeams(release),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("release-dir-writable");

    const resolved = resolveFlowingRecallPortConfig({
      settings: settingsFor(release.executable),
      ...testReleaseSeams(release),
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe("untrusted-executable");
  });

  test("the binding records device and inode for the directory, manifest, and artifact", () => {
    const release = testRelease();
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
      ...testReleaseSeams(release),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    for (const [identity, path] of [
      [outcome.binding.releaseDirIdentity, release.releaseDir],
      [outcome.binding.manifestIdentity, release.manifestPath],
      [outcome.binding.artifactIdentity, release.executable],
    ] as const) {
      const stat = statSync(path);
      expect(identity.dev).toBe(stat.dev);
      expect(identity.ino).toBe(stat.ino);
    }
  });

  test("an identical rebuild of the artifact fails the re-check that the digest passes", () => {
    const release = testRelease();
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
      ...testReleaseSeams(release),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(reverifyReleaseBinding(outcome.binding).ok).toBe(true);

    const body = readFileSync(release.executable);
    const before = statSync(release.executable).ino;
    withUnsealedRelease(release.releaseDir, () => {
      rmSync(release.executable);
      writeFileSync(release.executable, body);
      chmodSync(release.executable, 0o555);
    });

    // Byte-identical, same mode, same path. Only the inode moved.
    expect(statSync(release.executable).ino).not.toBe(before);
    expect(statSync(release.executable).mode & 0o222).toBe(0);

    const recheck = reverifyReleaseBinding(outcome.binding);
    expect(recheck.ok).toBe(false);
    if (recheck.ok) return;
    expect(recheck.reason).toBe("artifact-replaced");
  });

  test("a manifest rewritten in place with identical bytes fails the re-check", () => {
    const release = testRelease();
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
      ...testReleaseSeams(release),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const body = readFileSync(release.manifestPath);
    withUnsealedRelease(release.releaseDir, () => {
      rmSync(release.manifestPath);
      writeFileSync(release.manifestPath, body);
      chmodSync(release.manifestPath, 0o444);
    });

    const recheck = reverifyReleaseBinding(outcome.binding);
    expect(recheck.ok).toBe(false);
    if (recheck.ok) return;
    expect(recheck.reason).toBe("manifest-replaced");
  });

  test("a release directory swapped wholesale fails the re-check", () => {
    const release = testRelease();
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
      ...testReleaseSeams(release),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // A whole release rebuilt at the same path: every file inside is correct,
    // every mode is correct, and nothing about it is the release that was
    // verified. Only the directory's own inode says so.
    const replacement = testRelease({ releaseName: "replacement" });
    chmodSync(release.releaseDir, 0o755);
    chmodSync(replacement.releaseDir, 0o755);
    renameSync(release.releaseDir, join(release.root, "retired"));
    renameSync(replacement.releaseDir, release.releaseDir);
    chmodSync(release.releaseDir, 0o555);

    const recheck = reverifyReleaseBinding(outcome.binding);
    expect(recheck.ok).toBe(false);
    if (recheck.ok) return;
    expect(recheck.reason).toBe("release-dir-replaced");
  });

  test("a release directory made writable after verification fails the re-check", () => {
    const release = testRelease();
    const outcome = verifyReleaseArtifact({
      resolvedRoot: release.root,
      resolvedArtifact: release.executable,
      ...testReleaseSeams(release),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    chmodSync(release.releaseDir, 0o755);
    const recheck = reverifyReleaseBinding(outcome.binding);
    expect(recheck.ok).toBe(false);
    if (recheck.ok) return;
    expect(recheck.reason).toBe("release-dir-writable");
  });
});
