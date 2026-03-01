import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import matter from "gray-matter";
import { cacheLife, cacheTag } from "next/cache";
import { api } from "@/convex/_generated/api";
import { compareDateDesc, toDateString } from "./date";

/**
 * Post reader — Convex-only (ADR-0168).
 * No filesystem fallback. Convex is the canonical read-side.
 */

export type ContentType = "article" | "essay" | "note" | "tutorial";

export type PostMeta = {
  title: string;
  date: string;
  updated?: string;
  description: string;
  slug: string;
  type: ContentType;
  tags: string[];
  source?: string;
  channel?: string;
  duration?: string;
  draft?: boolean;
  image?: string;
};

export type PostDiagnostics = {
  source: "convex";
  resourceId: string;
  contentHash: string;
  contentLength: number;
  contentUpdatedAt?: number;
};

export type Post = {
  meta: PostMeta;
  content: string;
  diagnostics: PostDiagnostics;
};

const CONVEX_URL =
  process.env.CONVEX_URL?.trim() ??
  process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ??
  "";

let convexClient: ConvexHttpClient | null | undefined;

function getConvexClient(): ConvexHttpClient {
  if (convexClient) return convexClient;
  if (!CONVEX_URL) {
    throw new Error(
      "CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for article reads (ADR-0168: Convex is canonical)",
    );
  }
  convexClient = new ConvexHttpClient(CONVEX_URL);
  return convexClient;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function isContentType(value: unknown): value is ContentType {
  return value === "article" || value === "essay" || value === "note" || value === "tutorial";
}

function shouldIncludeDrafts(): boolean {
  return process.env.NODE_ENV === "development";
}

function stripLeadingFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;

  try {
    return matter(content).content;
  } catch {
    return content;
  }
}

type ParsedPostFields = {
  slug: string;
  title: string;
  date: string;
  updated?: string;
  description?: string;
  type: ContentType;
  tags: string[];
  source?: string;
  channel?: string;
  duration?: string;
  draft: boolean;
  image?: string;
  content?: string;
};

function parsePostFields(value: unknown, fallbackSlug?: string): ParsedPostFields | null {
  const fields = asRecord(value);
  const slug = asOptionalString(fields.slug) ?? fallbackSlug;
  const title = asOptionalString(fields.title);
  const date = toDateString(fields.date);
  const rawContent = asOptionalString(fields.content);
  const content = rawContent ? stripLeadingFrontmatter(rawContent) : undefined;
  if (!slug || !title || !date) return null;

  const typeValue = asOptionalString(fields.type);
  const type = isContentType(typeValue) ? typeValue : "article";
  const updated = toDateString(fields.updated) || undefined;

  return {
    slug,
    title,
    date,
    updated,
    description: asOptionalString(fields.description),
    type,
    tags: asStringArray(fields.tags),
    source: asOptionalString(fields.source),
    channel: asOptionalString(fields.channel),
    duration: asOptionalString(fields.duration),
    draft: fields.draft === true,
    image: asOptionalString(fields.image),
    content,
  };
}

function toPostMeta(fields: ParsedPostFields): PostMeta {
  return {
    title: fields.title,
    date: fields.date,
    updated: fields.updated,
    description: fields.description ?? "",
    slug: fields.slug,
    type: fields.type,
    tags: fields.tags,
    source: fields.source,
    channel: fields.channel,
    duration: fields.duration,
    draft: fields.draft,
    image: fields.image,
  };
}

function contentFingerprint(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

export async function getAllPosts(): Promise<PostMeta[]> {
  "use cache";
  cacheLife("days");
  cacheTag("articles");

  const convex = getConvexClient();
  const docs = await convex.query(api.contentResources.listByType, {
    type: "article",
    limit: 2000,
  });

  if (!Array.isArray(docs)) {
    throw new Error("Convex listByType returned a non-array payload for articles");
  }

  return docs
    .map((doc) => {
      const fields = parsePostFields(asRecord(doc).fields);
      if (!fields) return null;
      if (!shouldIncludeDrafts() && fields.draft) return null;
      return toPostMeta(fields);
    })
    .filter((post): post is PostMeta => post !== null)
    .sort((a, b) => compareDateDesc(a.date, b.date));
}

export async function getPost(slug: string): Promise<Post | null> {
  const convex = getConvexClient();
  const doc = await convex.query(api.contentResources.getByResourceId, {
    resourceId: `article:${slug}`,
  });

  if (!doc || typeof doc !== "object") return null;

  const docRecord = asRecord(doc);
  const docType = asOptionalString(docRecord.type);
  if (docType && docType !== "article") return null;

  const fields = parsePostFields(docRecord.fields, slug);
  if (!fields?.content) return null;
  if (!shouldIncludeDrafts() && fields.draft) return null;

  return {
    meta: toPostMeta(fields),
    content: fields.content,
    diagnostics: {
      source: "convex",
      resourceId: `article:${slug}`,
      contentHash: contentFingerprint(fields.content),
      contentLength: fields.content.length,
      contentUpdatedAt: asOptionalNumber(docRecord.updatedAt),
    },
  };
}

export async function getPostSlugs(): Promise<string[]> {
  "use cache";
  cacheLife("days");
  cacheTag("articles");

  const convex = getConvexClient();
  const docs = await convex.query(api.contentResources.listByType, {
    type: "article",
    limit: 2000,
  });

  if (!Array.isArray(docs)) {
    throw new Error("Convex listByType returned a non-array payload for article slugs");
  }

  return docs
    .map((doc) => {
      const fields = parsePostFields(asRecord(doc).fields);
      if (!fields) return null;
      if (!shouldIncludeDrafts() && fields.draft) return null;
      return fields.slug;
    })
    .filter((entry): entry is string => Boolean(entry));
}
