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

function buildSearchText(fields: ArticleFields): string {
  return [fields.slug, fields.title, fields.description, fields.content.slice(0, 500)]
    .filter((part) => part.length > 0)
    .join(" ");
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
        if (entry.name === "discoveries") continue;
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
  const fromEnv =
    process.env.CONVEX_URL?.trim() ?? process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ?? "";
  if (fromEnv.length > 0) return fromEnv;

  const envCandidates = [
    join(repoRoot, "apps", "web", ".env.local"),
    join(repoRoot, "apps", "web", ".env"),
  ];

  for (const filePath of envCandidates) {
    const direct = readEnvValueFromFile(filePath, "CONVEX_URL");
    if (direct) return direct;
    const publicUrl = readEnvValueFromFile(filePath, "NEXT_PUBLIC_CONVEX_URL");
    if (publicUrl) return publicUrl;
  }

  return "";
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
  const convexUrl = resolveConvexUrl(repoRoot);
  if (!convexUrl) {
    throw new Error("CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required.");
  }

  const contentDir = join(repoRoot, "apps", "web", "content");
  const articleFiles = listArticleFiles(contentDir);

  const convex = new ConvexHttpClient(convexUrl);
  const upsertRef = api.contentResources.upsert as FunctionReference<"mutation">;
  const getByResourceIdRef = api.contentResources.getByResourceId as FunctionReference<"query">;

  let inserted = 0;
  let updated = 0;

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
      draft: meta.draft === true,
    };

    const result = (await convex.mutation(upsertRef, {
      resourceId,
      type: "article",
      fields,
      searchText: buildSearchText(fields),
    })) as UpsertResult;

    if (result.action === "inserted") inserted += 1;
    if (result.action === "updated") updated += 1;

    const seeded = (await convex.query(getByResourceIdRef, {
      resourceId,
    })) as ContentResourceDocument | null;
    assertSeededDocument(slug, seeded);

    console.log(`[seed-articles] seeded ${slug} (${result.action ?? "ok"})`);
  }

  console.log(
    `[seed-articles] complete (${articleFiles.length} articles, inserted=${inserted}, updated=${updated})`,
  );
}

main().catch((error) => {
  console.error("[seed-articles] failed", error);
  process.exit(1);
});
