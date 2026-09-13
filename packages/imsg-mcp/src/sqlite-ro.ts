import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ImsgError } from "./imsg-cli.ts";

const SQLITE_CANTOPEN = 14;

/** `file:` URI that opens the database immutable: no locks, no WAL/journal reads, no writes. */
export function immutableUri(path: string): string {
  const encoded = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `file:${encoded}?immutable=1&mode=ro`;
}

function errcode(error: unknown): number | null {
  return typeof error === "object" && error !== null && typeof (error as { errcode?: unknown }).errcode === "number"
    ? (error as { errcode: number }).errcode
    : null;
}

/**
 * Open an Apple SQLite database read-only and immutable. A file that exists (or whose stat is
 * denied) but cannot be opened is reported as a Full Disk Access failure.
 */
export function openReadOnly(path: string, label: string): DatabaseSync {
  try {
    return new DatabaseSync(immutableUri(path), { readOnly: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    let exists = true;
    try {
      statSync(path);
    } catch (statError) {
      exists = (statError as NodeJS.ErrnoException).code !== "ENOENT";
    }
    if (!exists) throw new ImsgError(`${label} not found at ${path}`, null, "other");
    const denied = errcode(error) === SQLITE_CANTOPEN;
    throw new ImsgError(`cannot open ${label} at ${path}: ${detail}`, null, denied ? "fda" : "other");
  }
}

export function withReadOnly<T>(path: string, label: string, work: (db: DatabaseSync) => T): T {
  const db = openReadOnly(path, label);
  try {
    return work(db);
  } finally {
    db.close();
  }
}
