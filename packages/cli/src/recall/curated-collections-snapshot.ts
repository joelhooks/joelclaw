/**
 * Deprecated compatibility export.
 *
 * Production code must not read TypeScript source files at runtime. Tests that
 * verify the curated subset use `test-support/curated-collections-snapshot`.
 */
export const CRITICAL_COLLECTIONS_SNAPSHOT: readonly string[] = [
  "observations",
  "memory_observations",
  "brain_pages",
  "system_knowledge",
  "vault_notes",
]
