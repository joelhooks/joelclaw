import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { type AdrMeta, getAdr, getAdrSlugs } from "@/lib/adrs";
import { getPost, getPostSlugs, type PostMeta } from "@/lib/posts";

type ContentResourceDoc = {
  fields: unknown;
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
};

type PostFields = {
  slug: string;
  title: string;
  date: string;
  content: string;
  description?: string;
  image?: string;
};

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

function parseAdrFields(value: unknown): AdrFields | null {
  const fields = asRecord(value);
  const slug = asOptionalString(fields.slug);
  const title = asOptionalString(fields.title);
  const number = asOptionalString(fields.number);
  const status = asOptionalString(fields.status);
  const date = asOptionalString(fields.date);
  const content = asOptionalString(fields.content);
  if (!slug || !title || !number || !status || !date || !content) return null;

  return {
    slug,
    title,
    number,
    status,
    date,
    content,
    supersededBy: asOptionalString(fields.supersededBy),
    description: asOptionalString(fields.description),
  };
}

function parsePostFields(value: unknown): PostFields | null {
  const fields = asRecord(value);
  const slug = asOptionalString(fields.slug);
  const title = asOptionalString(fields.title);
  const date = asOptionalString(fields.date);
  const content = asOptionalString(fields.content);
  if (!slug || !title || !date || !content) return null;

  return {
    slug,
    title,
    date,
    content,
    description: asOptionalString(fields.description),
    image: asOptionalString(fields.image),
  };
}

async function queryAdrDoc(slug: string): Promise<ContentResourceDoc | null> {
  const convex = getConvexClient();
  if (!convex) return null;
  try {
    const doc = await convex.query(api.contentResources.getAdrBySlug, { slug });
    if (!doc || typeof doc !== "object") return null;
    return doc as ContentResourceDoc;
  } catch {
    return null;
  }
}

async function queryPostDoc(slug: string): Promise<ContentResourceDoc | null> {
  const convex = getConvexClient();
  if (!convex) return null;
  try {
    const doc = await convex.query(api.contentResources.getPostBySlug, { slug });
    if (!doc || typeof doc !== "object") return null;
    return doc as ContentResourceDoc;
  } catch {
    return null;
  }
}

function mergeAdrMeta(fields: AdrFields, fallback: AdrMeta | null): AdrMeta {
  return {
    title: fields.title,
    date: fields.date,
    status: fields.status,
    slug: fields.slug,
    number: fields.number,
    supersededBy: fields.supersededBy ?? fallback?.supersededBy,
    description: fields.description ?? fallback?.description,
  };
}

function defaultPostMeta(fields: PostFields): PostMeta {
  return {
    title: fields.title,
    date: fields.date,
    description: fields.description ?? "",
    slug: fields.slug,
    type: "article",
    tags: [],
    draft: false,
  };
}

function mergePostMeta(fields: PostFields, fallback: PostMeta | null): PostMeta {
  const base = fallback ?? defaultPostMeta(fields);
  return {
    ...base,
    title: fields.title,
    date: fields.date,
    description: fields.description ?? base.description,
    slug: fields.slug,
  };
}

export async function getAdrFromConvex(slug: string) {
  const fallback = await getAdr(slug);
  const doc = await queryAdrDoc(slug);
  const fields = parseAdrFields(doc?.fields);
  if (!fields) return fallback;
  return {
    meta: mergeAdrMeta(fields, fallback?.meta ?? null),
    content: fields.content,
  };
}

export async function getPostFromConvex(slug: string) {
  const fallback = await getPost(slug);
  const doc = await queryPostDoc(slug);
  const fields = parsePostFields(doc?.fields);
  if (!fields) return fallback;
  return {
    meta: mergePostMeta(fields, fallback?.meta ?? null),
    content: fields.content,
  };
}

export async function getAdrSlugsFromConvex(): Promise<string[]> {
  const fallback = await getAdrSlugs();
  const convex = getConvexClient();
  if (!convex) return fallback;

  try {
    const slugs = await convex.query(api.contentResources.getAllAdrSlugs, {});
    if (!Array.isArray(slugs)) return fallback;
    const valid = slugs.filter(
      (slug): slug is string => typeof slug === "string" && slug.length > 0,
    );
    return valid.length > 0 ? valid : fallback;
  } catch {
    return fallback;
  }
}

export async function getPostSlugsFromConvex(): Promise<string[]> {
  const fallback = await getPostSlugs();
  const convex = getConvexClient();
  if (!convex) return fallback;

  try {
    const slugs = await convex.query(api.contentResources.getAllPostSlugs, {});
    if (!Array.isArray(slugs)) return fallback;
    const valid = slugs.filter(
      (slug): slug is string => typeof slug === "string" && slug.length > 0,
    );
    return valid.length > 0 ? valid : fallback;
  } catch {
    return fallback;
  }
}
