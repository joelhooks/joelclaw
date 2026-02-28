#!/usr/bin/env bun

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { api } from "../apps/web/convex/_generated/api";
import { ConvexHttpClient } from "../apps/web/node_modules/convex/browser";
import type { FunctionReference } from "../apps/web/node_modules/convex/server";
import matter from "../apps/web/node_modules/gray-matter";

type ContentType = "article" | "essay" | "note" | "tutorial";

type ArticleFields = {
  slug: string;
  title: string;
  description: string;
  content: string;
  image?: string;
  tags: string[];
  type: ContentType;
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

function asContentType(value: unknown): ContentType {
  if (value === "essay" || value === "note" || value === "tutorial" || value === "article") {
    return value;
  }
  return "article";
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

async function verifySeedCoverage(
  getByResourceIdRef: FunctionReference<"query">,
  convex: ConvexHttpClient,
  expected: ReadonlyArray<{ slug: string; resourceId: string }>,
): Promise<void> {
  const failures: string[] = [];

  for (const item of expected) {
    const document = (await convex.query(getByResourceIdRef, {
      resourceId: item.resourceId,
    })) as ContentResourceDocument | null;

    try {
      assertSeededDocument(item.slug, document);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${item.resourceId}: ${reason}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`[seed-articles] verification failed:\n${failures.join("\n")}`);
  }
}

async function main() {
  const repoRoot = resolve(import.meta.dir, "..");
  const { url: convexUrl, adminAuth } = resolveConvexConfig(repoRoot);
  if (!convexUrl) {
    throw new Error(
      "CONVEX_URL, NEXT_PUBLIC_CONVEX_URL, or CONVEX_SELF_HOSTED_URL is required to seed articles.",
    );
  }

  const contentDir = join(repoRoot, "apps", "web", "content");
  const articleFiles = listArticleFiles(contentDir);
  if (articleFiles.length === 0) {
    console.log("[seed-articles] no article files found.");
    return;
  }

  const upsertRef = api.contentResources.upsert as FunctionReference<"mutation">;
  const getByResourceIdRef = api.contentResources.getByResourceId as FunctionReference<"query">;

  const convex = new ConvexHttpClient(convexUrl);
  if (adminAuth) {
    convex.setAdminAuth(adminAuth);
  }

  try {
    await convex.query(getByResourceIdRef, { resourceId: "__seed_probe__" });
  } catch (error) {
    throw new Error(
      `[seed-articles] Convex query probe failed at ${convexUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let inserted = 0;
  let updated = 0;
  const expectedResources: Array<{ slug: string; resourceId: string }> = [];
  const seenResourceIds = new Set<string>();

  for (const filePath of articleFiles) {
    const slug = slugFromFilePath(contentDir, filePath);
    const resourceId = `article:${slug}`;
    if (seenResourceIds.has(resourceId)) {
      throw new Error(`Duplicate article resourceId detected: ${resourceId}`);
    }
    seenResourceIds.add(resourceId);
    expectedResources.push({ slug, resourceId });

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
      type: asContentType(meta.type),
      date: toDateString(meta.date),
      updated: toDateString(meta.updated) || undefined,
      draft: asBoolean(meta.draft),
    };

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

  await verifySeedCoverage(getByResourceIdRef, convex, expectedResources);
  console.log(`[seed-articles] verified ${expectedResources.length} article resources in Convex`);

  console.log(
    `[seed-articles] complete (${articleFiles.length} articles, inserted=${inserted}, updated=${updated})`,
  );
}

main().catch((error) => {
  console.error("[seed-articles] failed", error);
  process.exit(1);
});
