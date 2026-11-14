import type { IntakeMetadata } from "./store";
import { IntakeRequestError, inlineBody } from "./stream";

/** Kept equal to the legacy route's DEFAULT_RUN_CAPTURE_MAX_INLINE_BYTES by a contract test. */
export const LEGACY_MAX_INLINE_BYTES = 10_000_000;
export function legacyBodyMetadata(metadata: IntakeMetadata) {
  const { user_id: _user, ...body } = metadata;
  const provenance = `forwarded-from:${metadata.machine_id}`;
  const tags = [...(metadata.tags ?? [])];
  if (!tags.includes(provenance)) tags.push(provenance);
  return { ...body, tags };
}
export function assertLegacyMinimumSize(metadata: IntakeMetadata): void {
  const overhead = Buffer.byteLength(
    JSON.stringify({ ...legacyBodyMetadata(metadata), jsonl: "" }),
  );
  if (overhead + metadata.jsonl_bytes > LEGACY_MAX_INLINE_BYTES)
    throw new IntakeRequestError(413, "legacy_inline_too_large");
}
/** The legacy cap counts JSON wire bytes, not decoded JSONL. Check escaping too. */
export async function assertLegacyInline(metadata: IntakeMetadata, path: string): Promise<void> {
  assertLegacyMinimumSize(metadata);
  const reader = inlineBody(legacyBodyMetadata(metadata), path).getReader();
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      bytes += next.value.length;
      if (bytes > LEGACY_MAX_INLINE_BYTES)
        throw new IntakeRequestError(413, "legacy_inline_too_large");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
