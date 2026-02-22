/**
 * Typesense index sync — keeps collections fresh after content changes.
 * ADR-0082: Typesense as unified search layer.
 *
 * Triggers:
 * - content/updated, discovery/captured, system/adr.sync.requested -> queue vault re-index
 * - typesense/vault-sync.requested -> perform vault re-index (targeted when paths provided)
 * - vercel/deploy.succeeded -> re-index blog posts
 * - cron daily 3am -> full re-index of vault + slog
 *
 * Uses auto-embedding (ts/all-MiniLM-L12-v2) — no external API calls.
 */

import { inngest } from "../client";
import * as typesense from "../../lib/typesense";
import { pushContentResource } from "../../lib/convex";
import { renderVaultMarkdown } from "../../lib/vault-render";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";

const VAULT_PATH = process.env.VAULT_PATH || join(process.env.HOME || "/Users/joel", "Vault");
const BLOG_PATH = join(process.env.HOME || "/Users/joel", "Code/joelhooks/joelclaw/apps/web/content");
const SLOG_PATH = join(VAULT_PATH, "system/system-log.jsonl");

const TYPESENSE_VAULT_QUEUE_KEY = '"typesense-vault-sync"';

// ── Vault indexing ──────────────────────────────────────────────────

function parseMarkdownFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  if (!content.startsWith("---")) return { frontmatter: fm, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: fm, body: content };

  const fmBlock = content.slice(4, end);
  for (const line of fmBlock.split("\n")) {
    const match = line.match(/^(\w[\w-]*):\s*(.+)/);
    if (match && match[1] && match[2]) fm[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return { frontmatter: fm, body: content.slice(end + 4).trim() };
}

function classifyNote(path: string, fm: Record<string, string>): string {
  if (path.includes("docs/decisions/")) return "adr";
  if (path.includes("Resources/discoveries/")) return "discovery";
  if (path.includes("Resources/tools/")) return "tool";
  if (path.includes("Projects/")) return "project";
  if (path.includes("system/log/")) return "log-entry";
  return fm.type || "note";
}

function walkDir(dir: string, ext: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        results.push(...walkDir(full, ext));
      } else if (entry.isFile() && extname(entry.name) === ext) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

function normalizeVaultRelativePath(pathLike: string): string | null {
  const raw = pathLike.trim();
  if (!raw) return null;

  const absolute = isAbsolute(raw) ? raw : join(VAULT_PATH, raw);
  const relPath = relative(VAULT_PATH, absolute);

  if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return null;
  if (extname(relPath) !== ".md") return null;

  return relPath;
}

function normalizeTargetPaths(paths?: string[]): string[] {
  if (!paths || paths.length === 0) return [];
  const unique = new Set<string>();
  for (const path of paths) {
    const relPath = normalizeVaultRelativePath(path);
    if (relPath) unique.add(relPath);
  }
  return [...unique];
}

function extractTargetPathsFromTrigger(event: {
  name: string;
  data: Record<string, unknown> | undefined;
}): string[] {
  const paths: string[] = [];
  const data = event.data ?? {};

  if (typeof data.path === "string") paths.push(data.path);
  if (Array.isArray(data.paths)) {
    for (const path of data.paths) {
      if (typeof path === "string") paths.push(path);
    }
  }
  if (typeof data.vaultPath === "string") paths.push(data.vaultPath);

  return normalizeTargetPaths(paths);
}

function buildVaultDoc(file: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(file, "utf-8");
    const { frontmatter, body } = parseMarkdownFrontmatter(raw);
    const relPath = relative(VAULT_PATH, file);
    const title = frontmatter.title || basename(file, ".md");
    const type = classifyNote(relPath, frontmatter);
    const tags = (frontmatter.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean);
    const stat = statSync(file);

    return {
      id: relPath,
      title,
      content: body.slice(0, 32000),
      path: relPath,
      type,
      tags,
      updated_at: Math.floor(stat.mtimeMs / 1000),
    };
  } catch {
    return null;
  }
}

async function indexVaultNotes(targetPaths?: string[]): Promise<{
  count: number;
  errors: number;
  mode: "targeted" | "full";
  targetCount: number;
}> {
  const normalizedTargets = normalizeTargetPaths(targetPaths);

  if (normalizedTargets.length > 0) {
    let count = 0;
    let errors = 0;

    for (const relPath of normalizedTargets) {
      const file = join(VAULT_PATH, relPath);
      try {
        if (!existsSync(file)) {
          await typesense.deleteDoc("vault_notes", relPath);
          count++;
          continue;
        }

        const doc = buildVaultDoc(file);
        if (!doc) {
          errors++;
          continue;
        }

        await typesense.upsert("vault_notes", doc);
        count++;
      } catch {
        errors++;
      }
    }

    return {
      count,
      errors,
      mode: "targeted",
      targetCount: normalizedTargets.length,
    };
  }

  const files = walkDir(VAULT_PATH, ".md");
  const docs: Record<string, unknown>[] = [];

  for (const file of files) {
    const doc = buildVaultDoc(file);
    if (doc) docs.push(doc);
  }

  if (docs.length === 0) {
    return {
      count: 0,
      errors: 0,
      mode: "full",
      targetCount: 0,
    };
  }

  // Batch in chunks of 100
  let totalSuccess = 0;
  let totalErrors = 0;
  for (let i = 0; i < docs.length; i += 100) {
    const batch = docs.slice(i, i + 100);
    const result = await typesense.bulkImport("vault_notes", batch);
    totalSuccess += result.success;
    totalErrors += result.errors;
  }

  return {
    count: totalSuccess,
    errors: totalErrors,
    mode: "full",
    targetCount: 0,
  };
}

async function syncVaultToConvex(targetPaths?: string[]): Promise<{
  synced: number;
  errors: number;
  mode: "targeted" | "full";
  targetCount: number;
}> {
  const allFiles = walkDir(VAULT_PATH, ".md");
  const allPaths = new Set(allFiles.map((f) => relative(VAULT_PATH, f)));

  const normalizedTargets = normalizeTargetPaths(targetPaths);
  const files = normalizedTargets.length > 0
    ? normalizedTargets
      .map((path) => join(VAULT_PATH, path))
      .filter((file) => existsSync(file))
    : allFiles;

  let synced = 0;
  let errors = 0;

  for (const file of files) {
    try {
      const raw = readFileSync(file, "utf-8");
      const { frontmatter, body } = parseMarkdownFrontmatter(raw);
      const relPath = relative(VAULT_PATH, file);
      const title = frontmatter.title || basename(file, ".md");
      const type = classifyNote(relPath, frontmatter);
      const tags = (frontmatter.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean);
      const stat = statSync(file);
      const section = relPath.split("/")[0] || "root";
      const content = body.slice(0, 32000);

      // Pre-render markdown -> HTML with Obsidian features
      let html: string | undefined;
      try {
        html = await renderVaultMarkdown(content, allPaths, relPath);
      } catch {
        // Fall back to no HTML — client will show raw markdown
      }

      const updatedAt = Math.floor(stat.mtimeMs / 1000);
      await pushContentResource(
        `vault:${relPath}`,
        "vault_note",
        {
          path: relPath,
          title,
          content,
          html,
          type,
          tags,
          section,
          updatedAt,
        },
        [title, content, tags.join(" "), section, type].filter(Boolean).join(" ")
      );
      synced++;
    } catch {
      errors++;
    }
  }

  console.log(`[convex-vault-sync] synced ${synced} notes (${errors} errors)`);

  return {
    synced,
    errors,
    mode: normalizedTargets.length > 0 ? "targeted" : "full",
    targetCount: normalizedTargets.length,
  };
}

// ── Blog indexing ───────────────────────────────────────────────────

async function indexBlogPosts(): Promise<{ success: number; errors: number }> {
  const files = walkDir(BLOG_PATH, ".mdx").filter(
    (f) => !f.includes("/adrs/") && !f.includes("/discoveries/")
  );
  const docs: Record<string, unknown>[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(file, "utf-8");
      const { frontmatter, body } = parseMarkdownFrontmatter(raw);
      const slug = basename(file, ".mdx");

      docs.push({
        id: slug,
        title: frontmatter.title || slug,
        slug,
        content: body.slice(0, 32000),
        summary: frontmatter.summary || frontmatter.description || "",
        tags: (frontmatter.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean),
        ...(frontmatter.date ? { published_at: Math.floor(new Date(frontmatter.date).getTime() / 1000) } : {}),
      });
    } catch {}
  }

  if (docs.length === 0) return { success: 0, errors: 0 };
  return typesense.bulkImport("blog_posts", docs);
}

// ── Slog indexing ───────────────────────────────────────────────────

async function indexSystemLog(): Promise<{ success: number; errors: number }> {
  const docs: Record<string, unknown>[] = [];
  try {
    const lines = readFileSync(SLOG_PATH, "utf-8").trim().split("\n");
    for (let i = 0; i < lines.length; i++) {
      try {
        const e = JSON.parse(lines[i]!);
        const doc: Record<string, unknown> = {
          id: String(i),
          action: e.action || "",
          tool: e.tool || "",
          detail: e.detail || "",
          reason: e.reason || "",
        };
        if (e.timestamp) {
          try {
            doc.timestamp = Math.floor(new Date(e.timestamp).getTime() / 1000);
          } catch {}
        }
        docs.push(doc);
      } catch {}
    }
  } catch {}

  if (docs.length === 0) return { success: 0, errors: 0 };
  const result = await typesense.bulkImport("system_log", docs);

  // Dual-write to Convex
  for (const doc of docs) {
    const entryId = String(doc.id);
    const action = String(doc.action || "");
    const tool = String(doc.tool || "");
    const detail = String(doc.detail || "");
    const reason = doc.reason ? String(doc.reason) : undefined;
    const timestamp = Number(doc.timestamp || 0);

    await pushContentResource(
      `slog:${entryId}`,
      "system_log",
      { entryId, action, tool, detail, reason, timestamp },
      [action, tool, detail, reason].filter(Boolean).join(" ")
    ).catch(() => {});
  }

  return result;
}

// ── Inngest functions ───────────────────────────────────────────────

/** Queue vault re-index requests from noisy upstream events */
export const typesenseVaultSyncQueue = inngest.createFunction(
  {
    id: "typesense/vault-sync-queue",
    name: "Typesense: Queue Vault Re-index",
    concurrency: { limit: 1, key: "typesense-vault-sync-queue" },
    debounce: { period: "45s", timeout: "3m", key: TYPESENSE_VAULT_QUEUE_KEY },
  },
  [
    { event: "content/updated" },
    { event: "discovery/captured" },
    { event: "system/adr.sync.requested" },
  ],
  async ({ event, step }) => {
    const targetPaths = extractTargetPathsFromTrigger({
      name: event.name,
      data: event.data as Record<string, unknown> | undefined,
    });

    await step.sendEvent("queue-vault-sync-request", {
      name: "typesense/vault-sync.requested",
      data: {
        source: (event.data as { source?: string } | undefined)?.source || event.name,
        triggerEvent: event.name,
        paths: targetPaths,
      },
    });

    console.log(
      `[typesense-vault-sync-queue] queued via ${event.name} (${targetPaths.length > 0 ? `${targetPaths.length} targeted` : "full"})`
    );

    return {
      queued: true,
      trigger: event.name,
      mode: targetPaths.length > 0 ? "targeted" : "full",
      targetCount: targetPaths.length,
    };
  }
);

/** Vault re-index worker — consumes queued requests */
export const typesenseVaultSync = inngest.createFunction(
  {
    id: "typesense/vault-sync",
    name: "Typesense: Vault Re-index",
    concurrency: { limit: 1, key: "typesense-vault-sync" },
    throttle: { limit: 1, period: "90s", key: TYPESENSE_VAULT_QUEUE_KEY },
    retries: 2,
  },
  [{ event: "typesense/vault-sync.requested" }],
  async ({ event, step }) => {
    const targetPaths = normalizeTargetPaths((event.data as { paths?: string[] } | undefined)?.paths);

    const result = await step.run("index-vault-notes", async () => {
      return indexVaultNotes(targetPaths);
    });

    const convexResult = await step.run("sync-vault-to-convex", async () => {
      return syncVaultToConvex(targetPaths);
    });

    console.log(
      `[typesense-vault-sync] mode=${result.mode} indexed ${result.count} vault notes (${result.errors} errors) via ${(event.data as { triggerEvent?: string } | undefined)?.triggerEvent || event.name}`
    );

    return {
      collection: "vault_notes",
      ...result,
      convex: convexResult,
      trigger: (event.data as { triggerEvent?: string } | undefined)?.triggerEvent || event.name,
    };
  }
);

/** Blog re-index — triggered by successful Vercel deploy */
export const typesenseBlogSync = inngest.createFunction(
  {
    id: "typesense/blog-sync",
    name: "Typesense: Blog Re-index",
    concurrency: { limit: 1, key: "typesense-blog-sync" },
  },
  [{ event: "vercel/deploy.succeeded" } as any],
  async ({ event, step }) => {
    const result = await step.run("index-blog-posts", async () => {
      return indexBlogPosts();
    });

    console.log(`[typesense-blog-sync] indexed ${result.success} blog posts (${result.errors} errors)`);
    return { collection: "blog_posts", ...result, trigger: event.name };
  }
);

/** Daily full re-index — safety net at 3am PST */
export const typesenseFullSync = inngest.createFunction(
  {
    id: "typesense/full-sync",
    name: "Typesense: Full Re-index (Daily)",
    concurrency: { limit: 1, key: "typesense-full-sync" },
  },
  [{ cron: "0 11 * * *" }], // 3am PST = 11:00 UTC
  async ({ step }) => {
    const vault = await step.run("index-vault", indexVaultNotes);
    const blog = await step.run("index-blog", indexBlogPosts);
    const slog = await step.run("index-slog", indexSystemLog);

    console.log(`[typesense-full-sync] vault=${vault.count} blog=${blog.success} slog=${slog.success}`);
    return { vault, blog, slog };
  }
);
