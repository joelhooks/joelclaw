/**
 * The production critical-search collection set, read out of the source file at
 * test time. The curated port must narrow within this set, never edit it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

function readCriticalCollections(): string[] {
  const source = readFileSync(join(import.meta.dir, "..", "lib", "critical-search.ts"), "utf-8");
  const block = source.match(/const CRITICAL_COLLECTIONS = \[(?<body>[\s\S]*?)\] as const/u);
  const body = block?.groups?.body ?? "";
  return [...body.matchAll(/"(?<name>[a-z_]+)"/gu)].map((match) => match.groups?.name ?? "");
}

export const CRITICAL_COLLECTIONS_SNAPSHOT: readonly string[] = readCriticalCollections();
