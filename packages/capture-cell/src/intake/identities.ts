import { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IDENTITIES = 10_000;
export interface IntakeIdentity {
  token_sha256: string;
  machine_id: string;
  user_id: string;
  revoked_at: number | null;
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
}
function rows(value: unknown): IntakeIdentity[] {
  if (!Array.isArray(value) || value.length > MAX_IDENTITIES) throw new Error("invalid identities");
  const hashes = new Set<string>();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (k) => !["token_sha256", "machine_id", "user_id", "revoked_at"].includes(k),
      ) ||
      typeof item.token_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/iu.test(item.token_sha256) ||
      !id(item.machine_id) ||
      !id(item.user_id) ||
      !(item.revoked_at === null || (Number.isSafeInteger(item.revoked_at) && item.revoked_at >= 0))
    )
      throw new Error("invalid identities");
    const token_sha256 = item.token_sha256.toLowerCase();
    if (hashes.has(token_sha256)) throw new Error("duplicate identity hash");
    hashes.add(token_sha256);
    return {
      token_sha256,
      machine_id: item.machine_id,
      user_id: item.user_id,
      revoked_at: item.revoked_at,
    };
  });
}
/** Read only Central's local auth cache; never create it or print a raw credential. */
export function exportIdentities(path: string): IntakeIdentity[] {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const result = rows(
      db
        .query(
          "SELECT token_sha256,machine_id,user_id,revoked_at FROM capture_identities ORDER BY machine_id LIMIT ?",
        )
        .all(MAX_IDENTITIES + 1),
    );
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_FILE_BYTES)
      throw new Error("identities file too large");
    return result;
  } finally {
    db.close(false);
  }
}

/** Last-good snapshot: cold failure disables machine tokens, never the ingest token.
 * Missing/invalid -> retain; changed valid -> replace; explicit [] -> clear.
 * No watcher, timer, outbound lookup or credential-bearing diagnostic.
 */
export function createIntakeIdentities(
  path: string,
  warn = () => console.error("capture intake identities reload failed; retaining last good set"),
) {
  let version = "";
  let failureVersion: string | undefined;
  let active: Array<{ identity: IntakeIdentity; hash: Buffer }> = [];
  function reload(force = false): void {
    let next = "missing";
    try {
      const stat = statSync(path, { bigint: true });
      next = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
      if (!force && next === version) return;
      version = next;
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("invalid identities file");
      const fd = openSync(path, "r");
      let value: unknown;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.size > MAX_FILE_BYTES)
          throw new Error("invalid identities file");
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const n = readSync(fd, buffer, length, buffer.length - length, null);
          if (!n) break;
          length += n;
        }
        if (length > MAX_FILE_BYTES) throw new Error("identities file too large");
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
        );
      } finally {
        closeSync(fd);
      }
      const validated = rows(value);
      const replacement = validated
        .filter((row) => row.revoked_at === null)
        .map((identity) => ({ identity, hash: Buffer.from(identity.token_sha256, "hex") }));
      active = replacement;
      failureVersion = undefined;
    } catch {
      version = next;
      if (force || next !== failureVersion) {
        try {
          warn();
        } catch {
          /* A diagnostic cannot disable the ingest token. */
        }
      }
      failureVersion = next;
    }
  }
  reload(true);
  return {
    reload,
    lookup(authorization: string | null): IntakeIdentity | null {
      if (!authorization?.startsWith("Bearer ")) return null;
      const hash = createHash("sha256").update(authorization.slice(7)).digest();
      let matched: IntakeIdentity | null = null;
      for (const row of active) if (timingSafeEqual(hash, row.hash)) matched = row.identity;
      return matched;
    },
  };
}
export type IntakeIdentities = ReturnType<typeof createIntakeIdentities>;
