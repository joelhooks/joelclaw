#!/usr/bin/env bun

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ConvexHttpClient } from "../apps/web/node_modules/convex/browser";
import { anyApi, type FunctionReference } from "../apps/web/node_modules/convex/server";
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
  return readdirSync(contentDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => join(contentDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
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

async function main() {
  const repoRoot = resolve(import.meta.dir, "..");
  const convexUrl = resolveConvexUrl(repoRoot);
  if (!convexUrl) {
    throw new Error("CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required.");
  }

  const contentDir = join(repoRoot, "apps", "web", "content");
  const articleFiles = listArticleFiles(contentDir);

  const convex = new ConvexHttpClient(convexUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upsertRef = (anyApi as any).contentResources.upsert as FunctionReference<"mutation">;

  for (const filePath of articleFiles) {
    const slug = basename(filePath, ".mdx");
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

    await convex.mutation(upsertRef, {
      resourceId: `article:${slug}`,
      type: "article",
      fields,
      searchText: buildSearchText(fields),
    });

    console.log(`[seed-articles] seeded ${slug}`);
  }

  console.log(`[seed-articles] complete (${articleFiles.length} articles)`);
}

main().catch((error) => {
  console.error("[seed-articles] failed", error);
  process.exit(1);
});
