import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import fs from "fs";
import matter from "gray-matter";
import { cacheLife, cacheTag } from "next/cache";
import path from "path";
import { api } from "@/convex/_generated/api";
import { compareDateDesc, toDateString } from "./date";

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
  source: "convex" | "filesystem";
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

const contentDir = path.join(process.cwd(), "content");

const CONVEX_URL =
  process.env.CONVEX_URL?.trim() ??
  process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ??
  "";

let convexClient: ConvexHttpClient | null | undefined;

function getConvexClient(): ConvexHttpClient | null {
  if (convexClient !== undefined) return convexClient;
  if (!CONVEX_URL) {
    convexClient = null;
    return convexClient;
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

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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

function canUseFilesystemFallback(): boolean {
  return process.env.NODE_ENV !== "production"
    && process.env.JOELCLAW_ALLOW_FILESYSTEM_POSTS_FALLBACK === "1";
}

function throwPostsError(message: string, error?: unknown): never {
  if (error instanceof Error) {
    throw new Error(`${message}: ${error.message}`, { cause: error });
  }
  if (typeof error === "string" && error.trim().length > 0) {
    throw new Error(`${message}: ${error}`);
  }
  throw new Error(message);
}

function fallbackOrThrow<T>(args: {
  message: string;
  error?: unknown;
  fallback: () => T;
}): T {
  if (!canUseFilesystemFallback()) {
    throwPostsError(args.message, args.error);
  }

  console.warn(
    `[posts] ${args.message}. Falling back to filesystem because JOELCLAW_ALLOW_FILESYSTEM_POSTS_FALLBACK=1.`,
  );
  return args.fallback();
}

function parsePostFields(value: unknown, fallbackSlug?: string): ParsedPostFields | null {
  const fields = asRecord(value);
  const slug = asOptionalString(fields.slug) ?? fallbackSlug;
  const title = asOptionalString(fields.title);
  const date = toDateString(fields.date);
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
    draft: asOptionalBoolean(fields.draft) ?? false,
    image: asOptionalString(fields.image),
    content: asOptionalString(fields.content),
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

function getAllPostsFromFilesystem(): PostMeta[] {
  const files = fs.readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));

  return files
    .map((filename) => {
      const raw = fs.readFileSync(path.join(contentDir, filename), "utf-8");
      const { data } = matter(raw);

      return {
        title: data.title ?? "Untitled",
        date: toDateString(data.date),
        updated: toDateString(data.updated) || undefined,
        description: data.description ?? "",
        slug: filename.replace(/\.mdx$/, ""),
        type: (data.type as ContentType) ?? "article",
        tags: Array.isArray(data.tags) ? data.tags : [],
        source: data.source,
        channel: data.channel,
        duration: data.duration,
        draft: data.draft ?? false,
        image: data.image,
      };
    })
    .filter((post) => shouldIncludeDrafts() || !post.draft)
    .sort((a, b) => compareDateDesc(a.date, b.date));
}

function getPostFromFilesystem(slug: string): Post | null {
  const filePath = path.join(contentDir, `${slug}.mdx`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);

  return {
    meta: {
      title: data.title ?? "Untitled",
      date: toDateString(data.date),
      updated: toDateString(data.updated) || undefined,
      description: data.description ?? "",
      slug,
      type: (data.type as ContentType) ?? "article",
      tags: Array.isArray(data.tags) ? data.tags : [],
      source: data.source,
      channel: data.channel,
      duration: data.duration,
      draft: data.draft ?? false,
      image: data.image,
    } satisfies PostMeta,
    content,
    diagnostics: {
      source: "filesystem",
      resourceId: `article:${slug}`,
      contentHash: contentFingerprint(content),
      contentLength: content.length,
      contentUpdatedAt: undefined,
    },
  };
}

function getPostSlugsFromFilesystem(): string[] {
  return getAllPostsFromFilesystem().map((post) => post.slug);
}

export async function getAllPosts(): Promise<PostMeta[]> {
  "use cache";
  cacheLife("days");
  cacheTag("articles");

  const convex = getConvexClient();
  if (!convex) {
    return fallbackOrThrow({
      message:
        "CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for article reads (runtime MDX fallback disabled)",
      fallback: getAllPostsFromFilesystem,
    });
  }

  try {
    const docs = await convex.query(api.contentResources.listByType, {
      type: "article",
      limit: 2000,
    });
    if (!Array.isArray(docs)) {
      return fallbackOrThrow({
        message: "Convex listByType returned a non-array payload for articles",
        fallback: getAllPostsFromFilesystem,
      });
    }

    const posts = docs
      .map((doc) => {
        const fields = parsePostFields(asRecord(doc).fields);
        if (!fields) return null;
        if (!shouldIncludeDrafts() && fields.draft) return null;
        return toPostMeta(fields);
      })
      .filter((post): post is PostMeta => post !== null)
      .sort((a, b) => compareDateDesc(a.date, b.date));

    if (docs.length > 0 && posts.length === 0) {
      return fallbackOrThrow({
        message: "Convex returned article docs but none passed schema parsing",
        fallback: getAllPostsFromFilesystem,
      });
    }

    return posts;
  } catch (error) {
    return fallbackOrThrow({
      message: "Convex article query failed",
      error,
      fallback: getAllPostsFromFilesystem,
    });
  }
}

export async function getPost(slug: string): Promise<Post | null> {
  "use cache";
  cacheLife("max");
  cacheTag(`article:${slug}`);
  cacheTag(`post:${slug}`);

  const convex = getConvexClient();
  if (!convex) {
    return fallbackOrThrow({
      message:
        `CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for article:${slug} reads (runtime MDX fallback disabled)`,
      fallback: () => getPostFromFilesystem(slug),
    });
  }

  try {
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
  } catch (error) {
    return fallbackOrThrow({
      message: `Convex article query failed for slug ${slug}`,
      error,
      fallback: () => getPostFromFilesystem(slug),
    });
  }
}

export async function getPostSlugs(): Promise<string[]> {
  "use cache";
  cacheLife("days");
  cacheTag("articles");

  const convex = getConvexClient();
  if (!convex) {
    return fallbackOrThrow({
      message:
        "CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for article slug reads (runtime MDX fallback disabled)",
      fallback: getPostSlugsFromFilesystem,
    });
  }

  try {
    const docs = await convex.query(api.contentResources.listByType, {
      type: "article",
      limit: 2000,
    });
    if (!Array.isArray(docs)) {
      return fallbackOrThrow({
        message: "Convex listByType returned a non-array payload for article slugs",
        fallback: getPostSlugsFromFilesystem,
      });
    }

    const slugs = docs
      .map((doc) => {
        const fields = parsePostFields(asRecord(doc).fields);
        if (!fields) return null;
        if (!shouldIncludeDrafts() && fields.draft) return null;
        return fields.slug;
      })
      .filter((entry): entry is string => Boolean(entry));

    if (docs.length > 0 && slugs.length === 0) {
      return fallbackOrThrow({
        message: "Convex returned article docs but none produced usable slugs",
        fallback: getPostSlugsFromFilesystem,
      });
    }

    return Array.from(new Set(slugs));
  } catch (error) {
    return fallbackOrThrow({
      message: "Convex article slug query failed",
      error,
      fallback: getPostSlugsFromFilesystem,
    });
  }
}
