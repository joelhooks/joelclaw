#!/usr/bin/env bun
/**
 * Bulk index Vault notes into Typesense.
 * Reads all .md files from ~/Vault, extracts frontmatter + content,
 * and upserts into the vault_notes collection.
 *
 * Usage: bun run scripts/typesense-index-vault.ts
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, basename } from "path";

const VAULT_PATH = process.env.HOME + "/Vault";
const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY ?? "";

if (!TYPESENSE_API_KEY) {
  console.error("TYPESENSE_API_KEY required. Run: export TYPESENSE_API_KEY=$(secrets lease typesense_api_key)");
  process.exit(1);
}

interface VaultDoc {
  id: string;
  title: string;
  content: string;
  type: string;
  tags?: string[];
  path: string;
  source: string;
  project?: string;
  updated_at?: number;
}

function parseFrontmatter(raw: string): { meta: Record<string, any>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, any> = {};
  const lines = (match[1] ?? "").split("\n");
  let currentKey = "";
  let inArray = false;
  const arrayValues: string[] = [];

  for (const line of lines) {
    if (inArray) {
      if (line.match(/^\s+-\s+/)) {
        arrayValues.push(line.replace(/^\s+-\s+/, "").trim());
        continue;
      } else {
        if (currentKey) {
          meta[currentKey] = arrayValues.slice();
        }
        arrayValues.length = 0;
        inArray = false;
      }
    }

    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = (kvMatch[1] ?? "").trim();
    const val = kvMatch[2] ?? "";
    if (!key) continue;

    if (val.trim() === "") {
      // might be array
      currentKey = key;
      inArray = true;
      continue;
    }

    // Handle inline arrays [a, b]
    const arrMatch = val.match(/^\[(.+)\]$/);
    if (arrMatch && arrMatch[1]) {
      meta[key] = arrMatch[1].split(",").map((s) => s.trim().replace(/['"]/g, ""));
    } else {
      meta[key] = val.trim().replace(/^['"]|['"]$/g, "");
    }
  }
  if (inArray && arrayValues.length > 0 && currentKey) {
    meta[currentKey] = arrayValues;
  }

  return { meta, body: match[2] ?? "" };
}

function classifyNote(path: string, meta: Record<string, any>): string {
  if (path.includes("docs/decisions/")) return "adr";
  if (path.includes("Projects/")) return "project";
  if (path.includes("Resources/discoveries/")) return "discovery";
  if (path.includes("Resources/tools/")) return "tool";
  if (path.includes("Resources/articles/")) return "article";
  if (path.includes("Resources/videos/")) return "video";
  if (path.includes("Resources/")) return "resource";
  if (path.includes("Daily/")) return "daily";
  if (path.includes("Areas/")) return "area";
  if (path.includes("inbox/")) return "inbox";
  if (meta.type) return String(meta.type);
  return "note";
}

function extractProject(path: string): string | undefined {
  const match = path.match(/Projects\/(\d+-[^/]+)/);
  return match?.[1];
}

function walkDir(dir: string, ext: string = ".md"): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, ext));
      } else if (entry.name.endsWith(ext)) {
        results.push(fullPath);
      }
    }
  } catch {}
  return results;
}

async function indexBatch(docs: VaultDoc[]): Promise<{ success: number; errors: number }> {
  // Typesense import API: JSONL format
  const jsonl = docs.map((d) => JSON.stringify(d)).join("\n");

  const resp = await fetch(`${TYPESENSE_URL}/collections/vault_notes/documents/import?action=upsert`, {
    method: "POST",
    headers: {
      "X-TYPESENSE-API-KEY": TYPESENSE_API_KEY,
      "Content-Type": "text/plain",
    },
    body: jsonl,
  });

  const text = await resp.text();
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  const success = lines.filter((l) => l.success).length;
  const errors = lines.filter((l) => !l.success).length;

  if (errors > 0) {
    const errMsgs = lines.filter((l) => !l.success).slice(0, 3);
    console.error("  Sample errors:", errMsgs);
  }

  return { success, errors };
}

async function main() {
  console.log(`Scanning ${VAULT_PATH} for .md files...`);
  const files = walkDir(VAULT_PATH);
  console.log(`Found ${files.length} files`);

  const docs: VaultDoc[] = [];
  let skipped = 0;

  for (const file of files) {
    try {
      const raw = readFileSync(file, "utf-8");
      const relPath = relative(VAULT_PATH, file);
      const { meta, body } = parseFrontmatter(raw);

      // Skip empty files
      if (body.trim().length < 10) {
        skipped++;
        continue;
      }

      // Truncate content for embedding efficiency (Typesense handles this, but let's be reasonable)
      const content = body.slice(0, 8000);

      const title =
        meta.title ||
        meta.aliases?.[0] ||
        body.match(/^#\s+(.+)/m)?.[1] ||
        basename(file, ".md");

      const tags = Array.isArray(meta.tags)
        ? meta.tags.map(String)
        : typeof meta.tags === "string"
          ? meta.tags.split(",").map((s: string) => s.trim())
          : undefined;

      const stat = statSync(file);

      docs.push({
        id: relPath.replace(/[^a-zA-Z0-9._-]/g, "_"),
        title: String(title),
        content,
        type: classifyNote(relPath, meta),
        tags: tags?.length ? tags : undefined,
        path: relPath,
        source: "vault",
        project: extractProject(relPath),
        updated_at: Math.floor(stat.mtimeMs / 1000),
      });
    } catch (err) {
      skipped++;
    }
  }

  console.log(`Prepared ${docs.length} docs (skipped ${skipped})`);

  // Index in batches of 40 (embedding generation is CPU-intensive)
  const BATCH_SIZE = 40;
  let totalSuccess = 0;
  let totalErrors = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const { success, errors } = await indexBatch(batch);
    totalSuccess += success;
    totalErrors += errors;
    const pct = Math.round(((i + batch.length) / docs.length) * 100);
    process.stdout.write(`\r  Indexed: ${totalSuccess}/${docs.length} (${pct}%) errors: ${totalErrors}`);
  }

  console.log(`\n\nDone! ${totalSuccess} indexed, ${totalErrors} errors, ${skipped} skipped`);
}

main().catch(console.error);
