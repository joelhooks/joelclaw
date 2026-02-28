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

type Post = {
  meta: PostMeta;
  content: string;
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
  };
}

function getPostSlugsFromFilesystem(): string[] {
  return getAllPostsFromFilesystem().map((post) => post.slug);
}

export async function getAllPosts(): Promise<PostMeta[]> {
  "use cache";
  cacheLife("days");
  cacheTag("articles");

  const fallback = getAllPostsFromFilesystem();
  const convex = getConvexClient();
  if (!convex) return fallback;

  try {
    const docs = await convex.query(api.contentResources.listByType, {
      type: "article",
      limit: 2000,
    });
    if (!Array.isArray(docs)) return fallback;

    const posts = docs
      .map((doc) => {
        const fields = parsePostFields(asRecord(doc).fields);
        if (!fields) return null;
        if (!shouldIncludeDrafts() && fields.draft) return null;
        return toPostMeta(fields);
      })
      .filter((post): post is PostMeta => post !== null)
      .sort((a, b) => compareDateDesc(a.date, b.date));

    return posts.length > 0 ? posts : fallback;
  } catch {
    return fallback;
  }
}

export async function getPost(slug: string): Promise<Post | null> {
  "use cache";
  cacheLife("max");
  cacheTag(`article:${slug}`);
  cacheTag(`post:${slug}`);

  const fallback = getPostFromFilesystem(slug);
  const convex = getConvexClient();
  if (!convex) return fallback;

  try {
    const doc = await convex.query(api.contentResources.getByResourceId, {
      resourceId: `article:${slug}`,
    });
    if (!doc || typeof doc !== "object") return fallback;
    const docRecord = asRecord(doc);
    const docType = asOptionalString(docRecord.type);
    if (docType && docType !== "article") return fallback;

    const fields = parsePostFields(docRecord.fields, slug);
    if (!fields?.content) return fallback;

    return {
      meta: toPostMeta(fields),
      content: fields.content,
    };
  } catch {
    return fallback;
  }
}

export async function getPostSlugs(): Promise<string[]> {
  "use cache";
  cacheLife("days");
  cacheTag("articles");

  const fallback = getPostSlugsFromFilesystem();
  const convex = getConvexClient();
  if (!convex) return fallback;

  try {
    const docs = await convex.query(api.contentResources.listByType, {
      type: "article",
      limit: 2000,
    });
    if (!Array.isArray(docs)) return fallback;

    const slugs = docs
      .map((doc) => {
        const fields = parsePostFields(asRecord(doc).fields);
        if (!fields) return null;
        if (!shouldIncludeDrafts() && fields.draft) return null;
        return fields.slug;
      })
      .filter((slug): slug is string => Boolean(slug));

    return slugs.length > 0 ? Array.from(new Set(slugs)) : fallback;
  } catch {
    return fallback;
  }
}
