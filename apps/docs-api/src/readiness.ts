const DOC_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const ARTIFACT_SOURCE_UNAVAILABLE_CODES = new Set([
  "ENOENT",
  "EIO",
  "ENOTCONN",
  "ESTALE",
  "ETIMEDOUT",
]);

export function isArtifactSourceUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "local_artifact_read_timeout") return true;
  return ARTIFACT_SOURCE_UNAVAILABLE_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

export function isValidArtifactDocId(value: string): boolean {
  return DOC_ID_PATTERN.test(value);
}

export type DocsReadinessSnapshot = {
  typesenseOk: boolean;
  docsCount: number;
  chunksCount: number;
  artifactsAvailable: boolean;
};

export function docsReadinessReasons(snapshot: DocsReadinessSnapshot): string[] {
  const reasons: string[] = [];
  if (!snapshot.typesenseOk) reasons.push("typesense_unavailable");
  if (snapshot.docsCount < 1) reasons.push("docs_collection_empty");
  if (snapshot.chunksCount < 1) reasons.push("chunks_collection_empty");
  if (!snapshot.artifactsAvailable) reasons.push("artifacts_unavailable");
  return reasons;
}
