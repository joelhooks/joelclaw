import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { ConvexHttpClient } from "convex/browser";
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asContentType(value: unknown): ContentType {
  switch (value) {
    case "article":
    case "essay":
    case "note":
    case "tutorial":
      return value;
    default:
      return "article";
  }
}

function parseSlugFromResourceId(value: unknown): string | undefined {
  const resourceId = asOptionalString(value);
  if (!resourceId) return undefined;
  const match = resourceId.match(/^article:(.+)$/);
  return match?.[1];
}

function mapDataToPostMeta(
  data: Record<string, unknown>,
  fallbackSlug: string | undefined,
): PostMeta | null {
  const slug = asOptionalString(data.slug) ?? fallbackSlug;
  if (!slug) return null;

  return {
    title: asOptionalString(data.title) ?? "Untitled",
    date: toDateString(data.date),
    updated: toDateString(data.updated) || undefined,
    description: asOptionalString(data.description) ?? "",
    slug,
    type: asContentType(data.type),
    tags: asStringArray(data.tags),
    source: asOptionalString(data.source),
    channel: asOptionalString(data.channel),
    duration: asOptionalString(data.duration),
    draft: asBoolean(data.draft),
    image: asOptionalString(data.image),
  };
}

function shouldIncludePost(post: PostMeta): boolean {
  return !post.draft;
}

function getAllPostsFromFilesystem(): PostMeta[] {
  if (!fs.existsSync(contentDir)) return [];
  const files = fs.readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));

  return files
    .map((filename) => {
      const raw = fs.readFileSync(path.join(contentDir, filename), "utf-8");
      const { data } = matter(raw);
      return mapDataToPostMeta(
        asRecord(data),
        filename.replace(/\.mdx$/, ""),
      );
    })
    .filter((post): post is PostMeta => post !== null)
    .filter(shouldIncludePost)
    .sort((a, b) => compareDateDesc(a.updated ?? a.date, b.updated ?? b.date));
}

function getPostFromFilesystem(slug: string) {
  const filePath = path.join(contentDir, `${slug}.mdx`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const meta = mapDataToPostMeta(asRecord(data), slug);
  if (!meta) return null;

  return {
    meta,
    content,
  };
}

function getPostSlugsFromFilesystem(): string[] {
  if (!fs.existsSync(contentDir)) return [];
  return fs
    .readdirSync(contentDir)
    .filter((f) => f.endsWith(".mdx"))
    .map((filename) => {
      const raw = fs.readFileSync(path.join(contentDir, filename), "utf-8");
      const { data } = matter(raw);
      const meta = mapDataToPostMeta(asRecord(data), filename.replace(/\.mdx$/, ""));
      return meta;
    })
    .filter((post): post is PostMeta => post !== null)
    .filter(shouldIncludePost)
    .map((post) => post.slug);
}

export async function getAllPosts(): Promise<PostMeta[]> {
  const convex = getConvexClient();
  if (!convex) return getAllPostsFromFilesystem();

  try {
    const docs = await convex.query(api.contentResources.listByType, {
      type: "article",
      limit: 1000,
    });
    if (!Array.isArray(docs)) return getAllPostsFromFilesystem();

    return docs
      .map((doc) => {
        const record = asRecord(doc);
        const fields = asRecord(record.fields);
        return mapDataToPostMeta(fields, parseSlugFromResourceId(record.resourceId));
      })
      .filter((post): post is PostMeta => post !== null)
      .filter(shouldIncludePost)
      .sort((a, b) => compareDateDesc(a.updated ?? a.date, b.updated ?? b.date));
  } catch {
    return getAllPostsFromFilesystem();
  }
}

export async function getPost(slug: string) {
  const convex = getConvexClient();
  if (!convex) return getPostFromFilesystem(slug);

  try {
    const doc = await convex.query(api.contentResources.getByResourceId, {
      resourceId: `article:${slug}`,
    });
    if (!doc || typeof doc !== "object") return null;

    const record = asRecord(doc);
    const fields = asRecord(record.fields);
    const content = asOptionalString(fields.content);
    if (!content) return null;

    const meta = mapDataToPostMeta(fields, slug);
    if (!meta) return null;

    return {
      meta,
      content,
    };
  } catch {
    return getPostFromFilesystem(slug);
  }
}

export async function getPostSlugs(): Promise<string[]> {
  const convex = getConvexClient();
  if (!convex) return getPostSlugsFromFilesystem();

  try {
    const docs = await convex.query(api.contentResources.listByType, {
      type: "article",
      limit: 1000,
    });
    if (!Array.isArray(docs)) return getPostSlugsFromFilesystem();

    return docs
      .map((doc) => {
        const record = asRecord(doc);
        const fields = asRecord(record.fields);
        return mapDataToPostMeta(fields, parseSlugFromResourceId(record.resourceId));
      })
      .filter((post): post is PostMeta => post !== null)
      .filter(shouldIncludePost)
      .map((post) => post.slug);
  } catch {
    return getPostSlugsFromFilesystem();
  }
}
