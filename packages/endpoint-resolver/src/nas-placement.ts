/**
 * NAS placement for the joelclaw fleet.
 *
 * 2026-09-08: the joelclaw tree moved from three-body (ASUSTOR, Cedar) to
 * maturin (Synology DS1825+, Terra). Three-body's `joelclaw` share is now
 * maturin's `services` share under `joelclaw/`, and service backups live on
 * maturin's `backups` share under `services/joelclaw/`.
 *
 * Machine config uses maturin's literal tailnet IP, not MagicDNS, per the
 * mount-address decision in the Brain (`projects/maturin-storage`).
 *
 * Every value is env-overridable so a satellite or a test can point elsewhere
 * without touching code. Legacy env names are honoured after the JOELCLAW_*
 * names so old `system-bus.env` files keep working.
 */

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** SSH target for scp/ssh work against the NAS. */
export const NAS_SSH_HOST =
  firstEnv("JOELCLAW_NAS_HOST", "SELF_HEALING_NAS_HOST", "NAS_SSH_HOST") ||
  "joel@100.102.65.115";

/** Local SMB mount of the joelclaw tree (three-body's old `/Volumes/three-body`). */
export const NAS_HDD_ROOT =
  firstEnv("JOELCLAW_NAS_HDD_ROOT", "SELF_HEALING_NAS_HDD_ROOT", "NAS_HDD_ROOT") ||
  "/Volumes/services/joelclaw";

/** Same tree as seen over SSH on the NAS itself. */
export const NAS_REMOTE_ROOT =
  firstEnv("JOELCLAW_NAS_REMOTE_ROOT") || "/volume1/services/joelclaw";

/** Local SMB mount of the fast NVMe share (three-body's old `/Volumes/nas-nvme`). */
export const NAS_NVME_ROOT =
  firstEnv("JOELCLAW_NAS_NVME_ROOT", "SELF_HEALING_NAS_NVME_ROOT", "NAS_NVME_ROOT") ||
  "/Volumes/fast";

/** Local SMB mount of service backups (typesense, redis, slog, ...). */
export const NAS_BACKUPS_HDD_ROOT =
  firstEnv("JOELCLAW_NAS_BACKUPS_HDD_ROOT") || "/Volumes/backups/services/joelclaw";

/** Service backups as seen over SSH on the NAS itself. */
export const NAS_BACKUPS_REMOTE_ROOT =
  firstEnv("JOELCLAW_NAS_BACKUPS_REMOTE_ROOT") || "/volume1/backups/services/joelclaw";

/** Mounts the system-health check expects on the central host. */
export const NAS_EXPECTED_MOUNTS: readonly { readonly name: string; readonly path: string }[] = [
  { name: "services", path: "/Volumes/services" },
  { name: "backups", path: "/Volumes/backups" },
  { name: "fast", path: "/Volumes/fast" },
];

export const DOCS_ARTIFACTS_DIR =
  firstEnv("JOELCLAW_DOCS_ARTIFACTS_DIR", "DOCS_ARTIFACTS_DIR") || `${NAS_HDD_ROOT}/docs-artifacts`;

export const DOCS_ARTIFACTS_REMOTE_DIR =
  firstEnv("DOCS_ARTIFACTS_SSH_ROOT") || `${NAS_REMOTE_ROOT}/docs-artifacts`;

export const NAS_BOOKS_ROOT = `${NAS_HDD_ROOT}/books`;
export const NAS_BOOKS_REMOTE_ROOT =
  firstEnv("JOELCLAW_NAS_BOOKS_DIR") || `${NAS_REMOTE_ROOT}/books/aa-book`;
export const NAS_MEDIA_REMOTE_ROOT =
  firstEnv("JOELCLAW_NAS_MEDIA_DIR") || `${NAS_REMOTE_ROOT}/media`;
export const NAS_VIDEO_REMOTE_ROOT =
  firstEnv("JOELCLAW_NAS_VIDEO_DIR") || `${NAS_REMOTE_ROOT}/video`;
export const NAS_SESSIONS_ROOT = `${NAS_HDD_ROOT}/sessions`;
export const NAS_INGEST_STAGING_ROOT = `${NAS_HDD_ROOT}/.ingest-staging`;
