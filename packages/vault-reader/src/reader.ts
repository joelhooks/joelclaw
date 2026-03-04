import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, normalize } from "node:path";
import type { VaultIntent } from "./types";

const VAULT_ROOT = normalize(process.env.VAULT_PATH ?? join(homedir(), "Vault"));
const MAX_MATCHES = 3;
const MAX_PREVIEW_CHARS = 12_000;
const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const LIST_CACHE_TTL_MS = 20_000;

let fileListCache: { at: number; files: string[] } | null = null;

export function extractVaultIntent(input: string): VaultIntent | null {
  const text = input.trim();
  if (!text) return null;

  const explicitPath = text.match(/(?:~\/Vault|\/Users\/[^/\s]+\/Vault)\/[^\s)]+/);
  if (explicitPath?.[0]) {
    return { kind: "path", value: explicitPath[0] };
  }

  const readByPath = text.match(/\bread\s+([~./][^\s]+)/i);
  if (readByPath?.[1] && (readByPath[1].includes("/") || readByPath[1].includes("."))) {
    return { kind: "path", value: readByPath[1] };
  }

  const adr = text.match(/\badr[-\s_]?0*(\d{1,4})\b/i);
  if (adr?.[1]) {
    return { kind: "adr", value: adr[1] };
  }

  if (!/\b(read|open|show|what(?:'s| is)\s+in|find)\b/i.test(text)) {
    return null;
  }

  const about = text.match(/\b(?:note|file)\s+about\s+(.+)$/i);
  if (about?.[1]) {
    return { kind: "fuzzy", value: about[1].trim() };
  }

  const tail = text.match(/\b(?:read|open|show|find)\s+(.+)$/i);
  if (tail?.[1]) {
    return { kind: "fuzzy", value: tail[1].trim() };
  }

  return null;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function parseAdrNumber(raw: string): string {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return raw;
  return String(n).padStart(4, "0");
}

function resolvePath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return normalize(join(homedir(), inputPath.slice(2)));
  }
  if (inputPath.startsWith("~")) {
    return normalize(join(homedir(), inputPath.slice(1)));
  }
  if (isAbsolute(inputPath)) {
    return normalize(inputPath);
  }
  return normalize(join(VAULT_ROOT, inputPath));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function isVaultPath(path: string): boolean {
  return path === VAULT_ROOT || path.startsWith(`${VAULT_ROOT}/`);
}

async function listVaultFiles(): Promise<string[]> {
  if (fileListCache && Date.now() - fileListCache.at <= LIST_CACHE_TTL_MS) {
    return fileListCache.files;
  }

  let files: string[] = [];
  try {
    const result = await Bun.$`rg --files ${VAULT_ROOT}`.quiet();
    files = result.stdout
      .toString()
      .split("\n")
      .map((line) => normalize(line.trim()))
      .filter(Boolean);
  } catch {
    files = [];
  }

  fileListCache = { at: Date.now(), files };
  return files;
}

function scoreCandidate(path: string, query: string, kind: VaultIntent["kind"]): number {
  const lowerPath = path.toLowerCase();
  const base = basename(path).toLowerCase();
  const queryLower = query.toLowerCase();
  let score = 0;

  if (base === `${queryLower}.md` || base === queryLower) score += 120;
  if (lowerPath.includes(queryLower)) score += 70;
  if (base.includes(queryLower)) score += 40;

  const tokens = tokenize(query);
  for (const token of tokens) {
    if (base.includes(token)) score += 22;
    else if (lowerPath.includes(token)) score += 8;
  }

  if (kind === "adr") {
    if (lowerPath.includes("/docs/decisions/")) score += 25;
    if (/\/\d{4}[-_]/.test(lowerPath)) score += 30;
  }

  if (SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) {
    score += 5;
  }

  return score;
}

async function findMatches(intent: VaultIntent): Promise<string[]> {
  if (intent.kind === "path") {
    const resolved = resolvePath(intent.value);
    if (!isVaultPath(resolved) || !(await fileExists(resolved))) return [];
    return [resolved];
  }

  const files = await listVaultFiles();
  if (files.length === 0) return [];

  const query = intent.kind === "adr" ? parseAdrNumber(intent.value) : intent.value;
  const scored = files
    .map((path) => ({ path, score: scoreCandidate(path, query, intent.kind) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES)
    .map((item) => item.path);

  return scored;
}

async function readPreview(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    if (content.length <= MAX_PREVIEW_CHARS) return content;
    return `${content.slice(0, MAX_PREVIEW_CHARS)}\n\n...[truncated]`;
  } catch (error) {
    return `[failed to read file: ${String(error)}]`;
  }
}

/** ADR-0204: Typesense fallback for semantic vault search when filename matching fails. */
async function searchKnowledgeTypesense(query: string, limit = 3): Promise<string[]> {
  const { spawnSync } = await import("node:child_process");
  try {
    const result = spawnSync(
      "joelclaw",
      ["knowledge", "search", query, "--limit", String(limit), "--json"],
      { encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0) return [];
    const parsed = JSON.parse(result.stdout?.trim() || "{}") as Record<string, unknown>;
    const res = parsed.result as Record<string, unknown> | undefined;
    const hits = Array.isArray(res?.hits) ? res.hits : [];
    if (hits.length === 0) return [];

    return hits.slice(0, limit).map((hit) => {
      const h = hit as Record<string, unknown>;
      const type = typeof h.type === "string" ? h.type : "doc";
      const title = typeof h.title === "string" ? h.title.trim() : "";
      const snippet = typeof h.snippet === "string" ? h.snippet.trim().slice(0, 500) : "";
      return `[${type}] **${title}**\n${snippet}`;
    });
  } catch {
    return [];
  }
}

export async function enrichPromptWithVaultContext(prompt: string): Promise<string> {
  const intent = extractVaultIntent(prompt);
  if (!intent) return prompt;

  const matches = await findMatches(intent);
  if (matches.length === 0) {
    // ADR-0204: fall back to Typesense semantic search before giving up
    const knowledgeHits = await searchKnowledgeTypesense(intent.value);
    if (knowledgeHits.length > 0) {
      return [
        prompt,
        "",
        "[Vault Resolver — Semantic Search]",
        `No exact file match for "${intent.value}", but found relevant knowledge:`,
        "",
        ...knowledgeHits,
      ].join("\n");
    }

    return [
      prompt,
      "",
      "[Vault Resolver]",
      `No vault file match found for: "${intent.value}" under ${VAULT_ROOT}.`,
      "If you need file contents, ask for a more specific path or title.",
    ].join("\n");
  }

  const previews = await Promise.all(matches.map((path) => readPreview(path)));
  const blocks = matches.map((path, idx) => {
    return [
      `${idx + 1}. ${path}`,
      "```md",
      previews[idx] ?? "",
      "```",
    ].join("\n");
  });

  return [
    prompt,
    "",
    "[Vault Resolver]",
    `Resolved ${matches.length} vault file(s) for query "${intent.value}".`,
    "Treat the file content below as primary context for this request.",
    "",
    ...blocks,
  ].join("\n");
}

