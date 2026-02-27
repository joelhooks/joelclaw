#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi, type FunctionReference } from "convex/server";
import matter from "gray-matter";

type AdrFields = {
  slug: string;
  title: string;
  number: string;
  status: string;
  date: string;
  content: string;
  supersededBy?: string;
  description?: string;
};

type PostFields = {
  slug: string;
  title: string;
  date: string;
  content: string;
  description?: string;
  image?: string;
};

const VALID_STATUSES = [
  "proposed",
  "accepted",
  "implemented",
  "superseded",
  "deprecated",
  "rejected",
] as const;

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

function normalizeStatus(raw: unknown): string {
  if (typeof raw !== "string") return "proposed";
  const lower = raw.toLowerCase().trim();
  for (const status of VALID_STATUSES) {
    if (lower === status || lower.startsWith(status)) return status;
  }
  return "proposed";
}

function extractAdrTitle(frontmatter: Record<string, unknown>, content: string): string {
  const title = asString(frontmatter.title);
  if (title) return title;
  const h1 = content.match(/^#\s+(?:ADR-\d+:\s*)?(.+)$/m);
  return h1?.[1]?.trim() ?? "Untitled";
}

function extractAdrDescription(content: string): string | undefined {
  const ctx = content.match(
    /## Context and Problem Statement\s+(.+?)(?:\n\n|\n##)/s,
  );
  const raw = ctx?.[1];
  if (!raw) return undefined;
  const first = (raw.split("\n\n")[0] ?? "").trim();
  if (!first) return undefined;
  return first.length > 200 ? `${first.slice(0, 197)}…` : first;
}

function listFiles(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((filePath) => extname(filePath) === extension);
}

function listPostFiles(contentRoot: string): string[] {
  const postsDir = join(contentRoot, "posts");
  const filesBySlug = new Map<string, string>();

  for (const filePath of listFiles(postsDir, ".mdx")) {
    filesBySlug.set(basename(filePath, ".mdx"), filePath);
  }

  // Current repo layout stores posts directly under apps/web/content/*.mdx.
  for (const filePath of listFiles(contentRoot, ".mdx")) {
    const slug = basename(filePath, ".mdx");
    if (!filesBySlug.has(slug)) {
      filesBySlug.set(slug, filePath);
    }
  }

  return Array.from(filesBySlug.values()).sort((a, b) => a.localeCompare(b));
}

function buildAdrSearchText(fields: AdrFields): string {
  return [
    fields.slug,
    fields.number,
    fields.title,
    fields.status,
    fields.date,
    fields.supersededBy,
    fields.description,
    fields.content,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

function buildPostSearchText(fields: PostFields): string {
  return [
    fields.slug,
    fields.title,
    fields.date,
    fields.description,
    fields.image,
    fields.content,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

async function main() {
  const convexUrl = process.env.CONVEX_URL?.trim();
  if (!convexUrl) {
    throw new Error("CONVEX_URL is required (example: https://...convex.cloud)");
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "../../..");
  const contentRoot = join(repoRoot, "apps", "web", "content");
  const adrDir = join(contentRoot, "adrs");

  const convex = new ConvexHttpClient(convexUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upsertRef = (anyApi as any).contentIngest
    .upsertContent as FunctionReference<"mutation">;

  const adrFiles = listFiles(adrDir, ".md")
    .filter((filePath) => basename(filePath) !== "README.md")
    .sort((a, b) => a.localeCompare(b));
  const postFiles = listPostFiles(contentRoot);

  console.log(`[sync-content] repoRoot=${repoRoot}`);
  console.log(`[sync-content] CONVEX_URL=${convexUrl}`);
  console.log(
    `[sync-content] found ${adrFiles.length} ADR files, ${postFiles.length} post files`,
  );

  let adrUpserts = 0;
  for (const filePath of adrFiles) {
    const slug = basename(filePath, ".md");
    const number = slug.match(/^(\d+)/)?.[1] ?? "";
    const raw = readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    const meta = data as Record<string, unknown>;

    const fields: AdrFields = {
      slug,
      title: extractAdrTitle(meta, content),
      number,
      status: normalizeStatus(meta.status),
      date: toDateString(meta.date),
      content,
      supersededBy: asString(meta["superseded-by"]) ?? asString(meta.supersededBy),
      description: asString(meta.description) ?? extractAdrDescription(content),
    };

    await convex.mutation(upsertRef, {
      resourceId: `adr:${slug}`,
      type: "adr",
      fields,
      searchText: buildAdrSearchText(fields),
    });
    adrUpserts += 1;
  }

  let postUpserts = 0;
  let skippedDrafts = 0;
  for (const filePath of postFiles) {
    const slug = basename(filePath, ".mdx");
    const raw = readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    const meta = data as Record<string, unknown>;

    if (meta.draft === true) {
      skippedDrafts += 1;
      continue;
    }

    const fields: PostFields = {
      slug,
      title: asString(meta.title) ?? "Untitled",
      date: toDateString(meta.date),
      content,
      description: asString(meta.description),
      image: asString(meta.image),
    };

    await convex.mutation(upsertRef, {
      resourceId: `post:${slug}`,
      type: "post",
      fields,
      searchText: buildPostSearchText(fields),
    });
    postUpserts += 1;
  }

  console.log(
    `[sync-content] complete adr=${adrUpserts} post=${postUpserts} skippedDrafts=${skippedDrafts}`,
  );
}

main().catch((error) => {
  console.error("[sync-content] failed", error);
  process.exit(1);
});
