#!/usr/bin/env bun

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { api } from "../apps/web/convex/_generated/api";
import { ConvexHttpClient } from "../apps/web/node_modules/convex/browser";
import type { FunctionReference } from "../apps/web/node_modules/convex/server";
import matter from "../apps/web/node_modules/gray-matter";

type ArticleFields = {
  slug: string;
  title: string;
  description: string;
  content: string;
  image?: string;
  tags: string[];
  type: "article";
  date: string;
  updated?: string;
  draft: boolean;
};

type UpsertResult = {
  action?: "inserted" | "updated";
  resourceId?: string;
};

type ContentResourceDocument = {
  type?: unknown;
  fields?: unknown;
};

type ConvexConfig = {
  url: string | null;
  adminAuth: string | null;
};

type SeedMode = "live" | "dry-run";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function toDateString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  if (typeof value === "number") return value === 1;
  return false;
}

function buildSearchText(fields: ArticleFields): string {
  return [fields.slug, fields.title, fields.description, fields.content.slice(0, 500)]
    .filter((part) => part.length > 0)
    .join(" ");
}

function isDiscoveriesPath(contentDir: string, entryPath: string): boolean {
  const relativePath = relative(contentDir, entryPath);
  if (!relativePath || relativePath.startsWith("..")) return false;
  return relativePath.split(sep).includes("discoveries");
}

function listArticleFiles(contentDir: string): string[] {
  const files: string[] = [];
  const directories = [contentDir];

  while (directories.length > 0) {
    const currentDir = directories.pop();
    if (!currentDir) continue;

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (isDiscoveriesPath(contentDir, entryPath)) continue;
        directories.push(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".mdx")) {
        files.push(entryPath);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function slugFromFilePath(contentDir: string, filePath: string): string {
  const relativePath = relative(contentDir, filePath);
  const withoutExtension = relativePath.replace(/\.mdx$/, "");
  return withoutExtension.split(sep).join("/");
}

function readEnvValueFromFile(filePath: string, key: string): string | undefined {
  let file: string;
  try {
    file = readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  for (const rawLine of file.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== key) continue;
    const value = match[2]?.trim() ?? "";
    const unquoted = value.replace(/^['"]|['"]$/g, "").trim();
    if (unquoted.length > 0) return unquoted;
  }

  return undefined;
}

function resolveConvexUrl(repoRoot: string): string {
  const fromEnvCandidates = [
    process.env.CONVEX_URL?.trim(),
    process.env.NEXT_PUBLIC_CONVEX_URL?.trim(),
    process.env.CONVEX_SELF_HOSTED_URL?.trim(),
  ];
  for (const candidate of fromEnvCandidates) {
    if (candidate && candidate.length > 0) return candidate;
  }

  const envCandidates = [
    join(repoRoot, "apps", "web", ".env.local"),
    join(repoRoot, "apps", "web", ".env"),
  ];

  for (const filePath of envCandidates) {
    const fileCandidates = [
      readEnvValueFromFile(filePath, "CONVEX_URL"),
      readEnvValueFromFile(filePath, "NEXT_PUBLIC_CONVEX_URL"),
      readEnvValueFromFile(filePath, "CONVEX_SELF_HOSTED_URL"),
    ];
    for (const candidate of fileCandidates) {
      if (candidate) return candidate;
    }
  }

  return "";
}

function resolveConvexAdminAuth(repoRoot: string): string | null {
  const fromEnvCandidates = [
    process.env.CONVEX_DEPLOY_KEY?.trim(),
    process.env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim(),
  ];
  for (const candidate of fromEnvCandidates) {
    if (candidate && candidate.length > 0) return candidate;
  }

  const envCandidates = [
    join(repoRoot, "apps", "web", ".env.local"),
    join(repoRoot, "apps", "web", ".env"),
  ];

  for (const filePath of envCandidates) {
    const fileValue =
      readEnvValueFromFile(filePath, "CONVEX_DEPLOY_KEY") ??
      readEnvValueFromFile(filePath, "CONVEX_SELF_HOSTED_ADMIN_KEY");
    if (fileValue) return fileValue;
  }

  return null;
}

function resolveConvexConfig(repoRoot: string): ConvexConfig {
  const url = resolveConvexUrl(repoRoot);
  return {
    url: url.length > 0 ? url : null,
    adminAuth: resolveConvexAdminAuth(repoRoot),
  };
}

function isConnectionRefusedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  if (
    message.includes("connectionrefused") ||
    message.includes("connection refused") ||
    message.includes("unable to connect") ||
    message.includes("fetch failed")
  ) {
    return true;
  }

  const code = (
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : ""
  ).toLowerCase();

  return code.includes("connectionrefused") || code.includes("econnrefused");
}

function assertSeededDocument(slug: string, document: ContentResourceDocument | null): void {
  if (!document) {
    throw new Error(`Upsert verification failed for ${slug}: record not found after mutation.`);
  }

  if (document.type !== "article") {
    throw new Error(`Upsert verification failed for ${slug}: expected type article.`);
  }

  if (
    !document.fields ||
    typeof document.fields !== "object" ||
    Array.isArray(document.fields) ||
    (document.fields as Record<string, unknown>).slug !== slug
  ) {
    throw new Error(`Upsert verification failed for ${slug}: fields.slug did not match.`);
  }
}

async function main() {
  const repoRoot = resolve(import.meta.dir, "..");
  const { url: convexUrl, adminAuth } = resolveConvexConfig(repoRoot);

  const contentDir = join(repoRoot, "apps", "web", "content");
  const articleFiles = listArticleFiles(contentDir);
  if (articleFiles.length === 0) {
    console.log("[seed-articles] no article files found.");
    return;
  }

  const upsertRef = api.contentResources.upsert as FunctionReference<"mutation">;
  const getByResourceIdRef = api.contentResources.getByResourceId as FunctionReference<"query">;

  let seedMode: SeedMode = "live";
  const strictConnectivity = asBoolean(process.env.SEED_ARTICLES_STRICT);
  const convex = convexUrl ? new ConvexHttpClient(convexUrl) : null;
  if (convex && adminAuth) {
    convex.setAdminAuth(adminAuth);
  }

  if (!convex || !convexUrl) {
    if (strictConnectivity) {
      throw new Error(
        "CONVEX_URL, NEXT_PUBLIC_CONVEX_URL, or CONVEX_SELF_HOSTED_URL is required when SEED_ARTICLES_STRICT=1.",
      );
    }

    seedMode = "dry-run";
    console.warn(
      "[seed-articles] no Convex URL configured; running in dry-run mode. Set SEED_ARTICLES_STRICT=1 to require Convex.",
    );
  } else {
    try {
      await convex.query(getByResourceIdRef, { resourceId: "__seed_probe__" });
    } catch (error) {
      if (strictConnectivity || !isConnectionRefusedError(error)) {
        throw error;
      }

      seedMode = "dry-run";
      console.warn(
        `[seed-articles] Convex unreachable at ${convexUrl}; running in dry-run mode. Set SEED_ARTICLES_STRICT=1 to fail on connectivity errors.`,
      );
    }
  }

  let inserted = 0;
  let updated = 0;
  let dryRun = 0;

  for (const filePath of articleFiles) {
    const slug = slugFromFilePath(contentDir, filePath);
    const resourceId = `article:${slug}`;
    const raw = readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    const meta = data as Record<string, unknown>;

    const fields: ArticleFields = {
      slug,
      title: asString(meta.title) ?? "Untitled",
      description: asString(meta.description) ?? "",
      content,
      image: asString(meta.image),
      tags: asStringArray(meta.tags),
      type: "article",
      date: toDateString(meta.date),
      updated: toDateString(meta.updated) || undefined,
      draft: asBoolean(meta.draft),
    };

    if (seedMode === "dry-run" || !convex) {
      dryRun += 1;
      console.log(`[seed-articles] seeded ${slug} (dry-run)`);
      continue;
    }

    const before = (await convex.query(getByResourceIdRef, {
      resourceId,
    })) as ContentResourceDocument | null;

    const result = (await convex.mutation(upsertRef, {
      resourceId,
      type: "article",
      fields,
      searchText: buildSearchText(fields),
    })) as UpsertResult;

    const action: "inserted" | "updated" = result.action ?? (before ? "updated" : "inserted");
    if (action === "inserted") inserted += 1;
    if (action === "updated") updated += 1;

    const seeded = (await convex.query(getByResourceIdRef, {
      resourceId,
    })) as ContentResourceDocument | null;
    assertSeededDocument(slug, seeded);

    console.log(`[seed-articles] seeded ${slug} (${action})`);
  }

  console.log(
    `[seed-articles] complete (${articleFiles.length} articles, inserted=${inserted}, updated=${updated}, dryRun=${dryRun}, mode=${seedMode})`,
  );
}

main().catch((error) => {
  console.error("[seed-articles] failed", error);
  process.exit(1);
});
