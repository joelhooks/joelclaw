#!/usr/bin/env bun
/**
 * Move only reviewed, fully indexed capture-outbox files into quarantine.
 *
 * Default mode is a read-only check. Mutation requires --execute. The catalog
 * may have been built from a frozen copy, so --outbox can point at the live
 * source. Every live file is checked against its catalog size and SHA first.
 * Missing, changed, or newly-created files are never moved.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CatalogEntry } from "./lib/capture-outbox-replay";

type ReviewedEntry = CatalogEntry & {
  archiveStatus?: "covered" | "full" | "suffix";
};

type Catalog = {
  schemaVersion: 2;
  sourceCount: number;
  representatives: number;
  entries: ReviewedEntry[];
};

type Row = {
  file: string;
  status: "matched" | "moved" | "skipped";
  bytes?: number;
  reason?: string;
};

const args = process.argv.slice(2);
const execute = args.includes("--execute");

function arg(name: string): string {
  const direct = args.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

function validateCatalog(catalog: Catalog): ReviewedEntry[] {
  if (catalog.schemaVersion !== 2) throw new Error("catalog schemaVersion must be 2");
  if (catalog.entries.length !== catalog.sourceCount) {
    throw new Error("catalog sourceCount does not match entries");
  }
  const files = new Set<string>();
  for (const entry of catalog.entries) {
    if (
      !entry.file
      || basename(entry.file) !== entry.file
      || files.has(entry.file)
      || !Number.isSafeInteger(entry.fileBytes)
      || entry.fileBytes < 0
      || !/^[a-f0-9]{64}$/u.test(entry.bodySha256)
    ) {
      throw new Error(`invalid or duplicate catalog entry: ${entry.file}`);
    }
    files.add(entry.file);
  }
  const representatives = catalog.entries.filter(
    (entry) => entry.disposition === "representative",
  );
  if (representatives.length !== catalog.representatives) {
    throw new Error("catalog representative count does not match entries");
  }
  const coveredRunIds = new Set(
    representatives
      .filter((entry) => entry.archiveStatus === "covered")
      .map((entry) => entry.runId),
  );
  if (coveredRunIds.size !== representatives.length) {
    throw new Error("catalog has a representative that is not covered");
  }
  for (const entry of catalog.entries) {
    if (entry.disposition === "representative") continue;
    if (
      (entry.disposition !== "redundant-prefix"
        && entry.disposition !== "redundant-exact")
      || !entry.supersededBy
      || !coveredRunIds.has(entry.supersededBy)
    ) {
      throw new Error(`catalog entry is not covered by a representative: ${entry.file}`);
    }
  }
  return catalog.entries;
}

function inspect(entry: ReviewedEntry, outbox: string, quarantine: string): Row {
  const source = join(outbox, entry.file);
  const destination = join(quarantine, entry.file);
  if (!existsSync(source)) return { file: entry.file, status: "skipped", reason: "missing" };
  const stat = lstatSync(source);
  if (!stat.isFile()) return { file: entry.file, status: "skipped", reason: "not-regular-file" };
  if (stat.size !== entry.fileBytes) {
    return { file: entry.file, status: "skipped", reason: "size-changed" };
  }
  if (sha256File(source) !== entry.bodySha256) {
    return { file: entry.file, status: "skipped", reason: "sha-changed" };
  }
  if (existsSync(destination)) {
    return { file: entry.file, status: "skipped", reason: "destination-exists" };
  }
  return { file: entry.file, status: "matched", bytes: stat.size };
}

function main(): void {
  const catalogPath = resolve(arg("--catalog"));
  const outbox = realpathSync(resolve(arg("--outbox")));
  const quarantine = resolve(arg("--quarantine"));
  const receiptPath = resolve(arg("--receipt"));
  if (quarantine === outbox || isInside(outbox, quarantine)) {
    throw new Error("quarantine must be outside the active outbox");
  }
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog;
  const entries = validateCatalog(catalog);
  const reviewed = entries.map((entry) => inspect(entry, outbox, quarantine));
  if (execute) mkdirSync(quarantine, { recursive: true, mode: 0o700 });

  const rows = reviewed.map((row, index) => {
    if (!execute || row.status !== "matched") return row;
    const entry = entries[index]!;
    const checked = inspect(entry, outbox, quarantine);
    if (checked.status !== "matched") {
      return {
        file: entry.file,
        status: "skipped" as const,
        reason: `changed-after-review:${checked.reason}`,
      };
    }
    renameSync(join(outbox, entry.file), join(quarantine, entry.file));
    return { file: entry.file, status: "moved" as const, bytes: checked.bytes };
  });

  const summary = {
    ok: true,
    mode: execute ? "execute" : "check",
    catalogPath,
    outbox,
    quarantine,
    catalogFiles: entries.length,
    matched: rows.filter((row) => row.status === "matched").length,
    moved: rows.filter((row) => row.status === "moved").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
    bytes: rows
      .filter((row) => row.status === "matched" || row.status === "moved")
      .reduce((total, row) => total + (row.bytes ?? 0), 0),
    rows,
  };
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  writeFileSync(receiptPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ ...summary, rows: summary.rows.length }, null, 2)}\n`,
  );
}

if (import.meta.main) main();
