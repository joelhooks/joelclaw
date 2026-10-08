import { basename, relative, resolve } from "node:path";
import { resolveSafeTemporaryDirectory } from "../../lib/protected-harness-paths";
export { resolveSafeTemporaryDirectory } from "../../lib/protected-harness-paths";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function normalizeTranscriptSlug(value: unknown): string {
  const slug =
    typeof value === "string"
      ? value
          .toLowerCase()
          .replace(/[^a-z0-9-]/gu, "-")
          .replace(/-+/gu, "-")
          .replace(/^-|-$/gu, "")
          .slice(0, 80)
          .replace(/-$/u, "")
      : "";
  return slug || "transcript";
}

type SafeVideoIngestPathOptions = {
  tmpRoot?: string;
  homeDir?: string;
  videoIngestRoot?: string;
};

/** Resolve only owned UUID directories under video-download's temp root. */
export function resolveSafeVideoIngestTempDir(
  candidate: unknown,
  options: SafeVideoIngestPathOptions = {},
): string | null {
  if (typeof candidate !== "string" || candidate.trim() === "") return null;

  const videoIngestRoot = resolve(options.videoIngestRoot ?? "/tmp/video-ingest");
  const safeRoot = resolveSafeTemporaryDirectory(videoIngestRoot, {
    tmpRoot: options.tmpRoot ?? "/tmp",
    homeDir: options.homeDir,
  });
  if (!safeRoot) return null;

  const safeCandidate = resolveSafeTemporaryDirectory(candidate, {
    tmpRoot: safeRoot,
    homeDir: options.homeDir,
  });
  if (!safeCandidate) return null;

  const childName = relative(safeRoot, safeCandidate);
  if (!UUID_PATTERN.test(childName) || childName !== basename(safeCandidate)) return null;
  return safeCandidate;
}
