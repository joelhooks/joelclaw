/**
 * Convex content sync — upserts ADR, discovery, and post files into Convex contentResources.
 *
 * Used by:
 * - content-sync Inngest function (incremental, after vault sync)
 * - scripts/sync-content-to-convex.ts (full sync, manual)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { anyApi, type FunctionReference } from "convex/server";
import matter from "gray-matter";

const CONVEX_URL = process.env.CONVEX_URL?.trim()
  || process.env.NEXT_PUBLIC_CONVEX_URL?.trim()
  || "https://tough-panda-917.convex.cloud";

type AdrPriorityFields = {
  priorityNeed?: number;
  priorityReadiness?: number;
  priorityConfidence?: number;
  priorityScore?: number;
  priorityBand?: string;
  priorityReviewed?: string;
  priorityRationale?: string;
};

type AdrFields = {
  slug: string;
  title: string;
  number: string;
  status: string;
  date: string;
  content: string;
  supersededBy?: string;
  description?: string;
} & AdrPriorityFields;

type PostFields = {
  slug: string;
  title: string;
  date: string;
  content: string;
  description?: string;
  image?: string;
  updated?: string;
  type?: string;
  tags?: string[];
  source?: string;
  channel?: string;
  duration?: string;
  draft?: boolean;
};

type DiscoveryFields = {
  title: string;
  slug: string;
  source: string;
  discovered: string;
  tags: string[];
  relevance: string;
  content: string;
};

const VALID_STATUSES = [
  "proposed",
  "accepted",
  "implemented",
  "shipped",
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

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const VALID_BANDS = ["do-now", "next", "de-risk", "park"] as const;

function normalizeband(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const lower = raw.toLowerCase().trim();
  return (VALID_BANDS as readonly string[]).includes(lower) ? lower : undefined;
}

function extractPriorityFields(meta: Record<string, unknown>): AdrPriorityFields {
  const band = normalizeband(meta["priority-band"]);
  if (!band) return {}; // no band = no rubric applied

  return {
    priorityNeed: asOptionalNumber(meta["priority-need"]),
    priorityReadiness: asOptionalNumber(meta["priority-readiness"]),
    priorityConfidence: asOptionalNumber(meta["priority-confidence"]),
    priorityScore: asOptionalNumber(meta["priority-score"]),
    priorityBand: band,
    priorityReviewed: toDateString(meta["priority-reviewed"]) || undefined,
    priorityRationale: asString(meta["priority-rationale"]),
  };
}

function normalizeStatus(raw: unknown): string {
  if (typeof raw !== "string") return "proposed";
  const lower = raw.toLowerCase().trim();
  for (const status of VALID_STATUSES) {
    if (lower === status || lower.startsWith(status)) return status;
  }
  return "proposed";
}

function extractHeadingTitle(content: string): string | undefined {
  const h1 = content.match(/^#\s+(?:ADR-\d+:\s*)?(.+)$/m);
  return h1?.[1]?.trim();
}

function extractAdrTitle(frontmatter: Record<string, unknown>, content: string): string {
  const title = asString(frontmatter.title);
  if (title) return title;
  return extractHeadingTitle(content) ?? "Untitled";
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

function buildAdrSearchText(fields: AdrFields): string {
  return [
    fields.slug, fields.number, fields.title, fields.status,
    fields.date, fields.supersededBy, fields.description, fields.content,
  ].filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

function buildPostSearchText(fields: PostFields): string {
  return [
    fields.slug, fields.title, fields.date, fields.type,
    fields.description, fields.image, fields.content,
    ...(fields.tags ?? []),
  ].filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

function buildDiscoverySearchText(fields: DiscoveryFields): string {
  return [
    fields.title,
    fields.slug,
    fields.source,
    fields.discovered,
    fields.relevance,
    fields.content,
    ...fields.tags,
  ].filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

export type ConvexSyncResult = {
  adrUpserts: number;
  postUpserts: number;
  errors: string[];
};

let _client: ConvexHttpClient | undefined;

function getClient(): ConvexHttpClient {
  if (!_client) {
    _client = new ConvexHttpClient(CONVEX_URL);
  }
  return _client;
}

const upsertRef = (anyApi as any).contentIngest.upsertContent as FunctionReference<"mutation">;

function contentHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Upsert a single ADR file into Convex.
 * Returns "inserted" | "updated" | "skipped".
 */
export async function upsertAdr(filePath: string): Promise<string> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const slug = basename(filePath, extname(filePath));
  const number = slug.match(/^(\d+)/)?.[1] ?? "";
  const raw = readFileSync(filePath, "utf-8");
  const hash = contentHash(raw);
  const { data, content } = matter(raw);
  const meta = data as Record<string, unknown>;

  const priority = extractPriorityFields(meta);

  const fields: AdrFields = {
    slug,
    title: extractAdrTitle(meta, content),
    number,
    status: normalizeStatus(meta.status),
    date: toDateString(meta.date),
    content,
    supersededBy: asString(meta["superseded-by"]) ?? asString(meta.supersededBy),
    description: asString(meta.description) ?? extractAdrDescription(content),
    ...priority,
  };

  const result = await getClient().mutation(upsertRef, {
    resourceId: `adr:${slug}`,
    type: "adr" as const,
    fields,
    searchText: buildAdrSearchText(fields),
    contentHash: hash,
  });
  return result?.action ?? "updated";
}

/**
 * Upsert a single post (MDX) file into Convex. Skips drafts.
 * Returns "inserted" | "updated" | "skipped" | "draft" (skipped because draft).
 */
export async function upsertPost(filePath: string): Promise<string> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const slug = basename(filePath, extname(filePath));
  const raw = readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const meta = data as Record<string, unknown>;

  if (meta.draft === true) return "draft";

  const hash = contentHash(raw);
  const tags = Array.isArray(meta.tags)
    ? meta.tags.filter((t: unknown): t is string => typeof t === "string")
    : [];

  const fields: PostFields = {
    slug,
    title: asString(meta.title) ?? "Untitled",
    date: toDateString(meta.date),
    content,
    description: asString(meta.description),
    image: asString(meta.image),
    updated: toDateString(meta.updated) || undefined,
    type: asString(meta.type) ?? "article",
    tags: tags.length > 0 ? tags : undefined,
    source: asString(meta.source),
    channel: asString(meta.channel),
    duration: asString(meta.duration),
    draft: meta.draft === true ? true : undefined,
  };

  const result = await getClient().mutation(upsertRef, {
    resourceId: `post:${slug}`,
    type: "post" as const,
    fields,
    searchText: buildPostSearchText(fields),
    contentHash: hash,
  });
  return result?.action ?? "updated";
}

/**
 * Upsert a single discovery (MD) file into Convex. Skips private discoveries.
 * Returns "inserted" | "updated" | "skipped" | "private" (skipped because private).
 */
export async function upsertDiscovery(filePath: string): Promise<string> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const fallbackSlug = basename(filePath, extname(filePath));
  const raw = readFileSync(filePath, "utf-8");
  const hash = contentHash(raw);
  const { data, content } = matter(raw);
  const meta = data as Record<string, unknown>;

  if (meta.private === true) return "private";

  const tags = Array.isArray(meta.tags)
    ? meta.tags.filter((t: unknown): t is string => typeof t === "string")
    : [];
  const slug = asString(meta.slug) ?? fallbackSlug;

  const fields: DiscoveryFields = {
    title: extractHeadingTitle(content) ?? slug,
    slug,
    source: asString(meta.source) ?? "",
    discovered: toDateString(meta.discovered),
    tags,
    relevance: asString(meta.relevance) ?? "",
    content,
  };

  const result = await getClient().mutation(upsertRef, {
    resourceId: `discovery:${slug}`,
    type: "discovery" as const,
    fields,
    searchText: buildDiscoverySearchText(fields),
    contentHash: hash,
  });
  return result?.action ?? "updated";
}

/**
 * Upsert multiple content files into Convex. Handles mixed ADR/post paths.
 * Files are identified by extension (.md → ADR, .mdx → post).
 */
export async function upsertFiles(filePaths: string[]): Promise<ConvexSyncResult> {
  const result: ConvexSyncResult = { adrUpserts: 0, postUpserts: 0, errors: [] };

  for (const filePath of filePaths) {
    try {
      const ext = extname(filePath);
      if (ext === ".md") {
        await upsertAdr(filePath);
        result.adrUpserts++;
      } else if (ext === ".mdx") {
        const upserted = await upsertPost(filePath);
        if (upserted) result.postUpserts++;
      }
    } catch (err) {
      result.errors.push(`${basename(filePath)}: ${String(err)}`);
    }
  }

  return result;
}
