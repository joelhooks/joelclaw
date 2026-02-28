import { ConvexHttpClient } from "convex/browser";
import fs from "fs";
import matter from "gray-matter";
import { cacheLife, cacheTag } from "next/cache";
import path from "path";
import { api } from "@/convex/_generated/api";

export type DiscoveryMeta = {
  title: string;
  slug: string;
  source: string;
  discovered: string;
  tags: string[];
  relevance: string;
  /** Sort tiebreaker (Convex updatedAt or file mtime epoch ms) */
  _mtime?: number;
};

type ParsedDiscoveryFields = {
  title: string;
  slug: string;
  source: string;
  discovered: string;
  tags: string[];
  relevance: string;
  content?: string;
};

const discoveriesDir = path.join(process.cwd(), "content", "discoveries");

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

function canUseFilesystemFallback(): boolean {
  return process.env.NODE_ENV !== "production"
    && process.env.JOELCLAW_ALLOW_FILESYSTEM_CONTENT_FALLBACK === "1";
}

function throwDiscoveriesError(message: string, error?: unknown): never {
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
    throwDiscoveriesError(args.message, args.error);
  }

  console.warn(
    `[discoveries] ${args.message}. Falling back to filesystem because JOELCLAW_ALLOW_FILESYSTEM_CONTENT_FALLBACK=1.`,
  );
  return args.fallback();
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function slugFromResourceId(value: unknown): string | undefined {
  const raw = asOptionalString(value);
  if (!raw) return undefined;
  if (!raw.startsWith("discovery:")) return undefined;
  const slug = raw.slice("discovery:".length).trim();
  return slug.length > 0 ? slug : undefined;
}

function extractDiscoveryTitle(
  frontmatter: Record<string, unknown>,
  content: string,
  fallback: string,
): string {
  const title = asOptionalString(frontmatter.title);
  if (title) return title;
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1?.[1]) return h1[1].trim();
  return fallback;
}

function stripFirstH1(content: string): string {
  return content.replace(/^#\s+.+\n*/m, "");
}

function parseDiscoveryFields(
  value: unknown,
  fallbackSlug?: string,
): ParsedDiscoveryFields | null {
  const fields = asRecord(value);

  const titleField = asOptionalString(fields.title);
  const slug =
    asOptionalString(fields.slug)
    ?? fallbackSlug
    ?? (titleField ? slugify(titleField) : undefined);
  if (!slug) return null;

  const content = asOptionalString(fields.content);
  const title = titleField ?? (content ? extractDiscoveryTitle({}, content, slug) : slug);
  if (!title) return null;

  return {
    title,
    slug,
    source: asOptionalString(fields.source) ?? "",
    discovered: asOptionalString(fields.discovered) ?? "",
    tags: asStringArray(fields.tags),
    relevance: asOptionalString(fields.relevance) ?? "",
    content,
  };
}

function toDiscoveryMeta(
  fields: ParsedDiscoveryFields,
  mtime?: number,
): DiscoveryMeta {
  return {
    title: fields.title,
    slug: fields.slug,
    source: fields.source,
    discovered: fields.discovered,
    tags: fields.tags,
    relevance: fields.relevance,
    _mtime: mtime,
  };
}

function sortDiscoveries(a: DiscoveryMeta, b: DiscoveryMeta): number {
  if (a.discovered !== b.discovered) {
    return a.discovered > b.discovered ? -1 : 1;
  }
  return (b._mtime ?? 0) - (a._mtime ?? 0);
}

function getAllDiscoveriesFromFilesystem(): DiscoveryMeta[] {
  if (!fs.existsSync(discoveriesDir)) return [];
  const files = fs
    .readdirSync(discoveriesDir)
    .filter((f) => f.endsWith(".md"));

  return files
    .map((filename) => {
      const filePath = path.join(discoveriesDir, filename);
      const raw = fs.readFileSync(filePath, "utf-8");
      const mtime = fs.statSync(filePath).mtimeMs;
      const { data, content } = matter(raw);

      const defaultSlug = slugify(filename.replace(/\.md$/, ""));
      const slug = asOptionalString(data.slug) ?? defaultSlug;
      const title = extractDiscoveryTitle(data, content, filename.replace(/\.md$/, ""));

      return {
        title,
        slug,
        source: asOptionalString(data.source) ?? "",
        discovered: asOptionalString(data.discovered) ?? "",
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        relevance: asOptionalString(data.relevance) ?? "",
        _mtime: mtime,
      } satisfies DiscoveryMeta;
    })
    .sort(sortDiscoveries);
}

function getDiscoveryFromFilesystem(slug: string) {
  if (!fs.existsSync(discoveriesDir)) return null;

  const files = fs.readdirSync(discoveriesDir).filter((f) => f.endsWith(".md"));

  for (const filename of files) {
    const raw = fs.readFileSync(path.join(discoveriesDir, filename), "utf-8");
    const { data, content } = matter(raw);

    const defaultSlug = slugify(filename.replace(/\.md$/, ""));
    const fileSlug = asOptionalString(data.slug) ?? defaultSlug;

    if (fileSlug !== slug) continue;

    const title = extractDiscoveryTitle(data, content, filename.replace(/\.md$/, ""));
    const strippedContent = stripFirstH1(content);

    return {
      meta: {
        title,
        slug: fileSlug,
        source: asOptionalString(data.source) ?? "",
        discovered: asOptionalString(data.discovered) ?? "",
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        relevance: asOptionalString(data.relevance) ?? "",
      } satisfies DiscoveryMeta,
      content: strippedContent,
    };
  }

  return null;
}

function getDiscoverySlugsFromFilesystem(): string[] {
  if (!fs.existsSync(discoveriesDir)) return [];
  return fs
    .readdirSync(discoveriesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = fs.readFileSync(path.join(discoveriesDir, f), "utf-8");
      const { data } = matter(raw);
      return asOptionalString(data.slug) ?? slugify(f.replace(/\.md$/, ""));
    });
}

export async function getAllDiscoveries(): Promise<DiscoveryMeta[]> {
  "use cache";
  cacheLife("days");
  cacheTag("discoveries");

  const convex = getConvexClient();
  if (!convex) {
    return fallbackOrThrow({
      message:
        "CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for discovery reads (runtime filesystem fallback disabled)",
      fallback: getAllDiscoveriesFromFilesystem,
    });
  }

  try {
    const docs = await convex.query(api.contentResources.listByType, {
      type: "discovery",
      limit: 5000,
    });

    if (!Array.isArray(docs)) {
      return fallbackOrThrow({
        message: "Convex listByType returned a non-array payload for discoveries",
        fallback: getAllDiscoveriesFromFilesystem,
      });
    }

    const discoveries = docs
      .map((doc) => {
        const record = asRecord(doc);
        const fields = parseDiscoveryFields(
          record.fields,
          slugFromResourceId(record.resourceId),
        );
        if (!fields) return null;
        return toDiscoveryMeta(fields, asOptionalNumber(record.updatedAt));
      })
      .filter((entry): entry is DiscoveryMeta => entry !== null)
      .sort(sortDiscoveries);

    if (docs.length > 0 && discoveries.length === 0) {
      return fallbackOrThrow({
        message: "Convex returned discovery docs but none passed schema parsing",
        fallback: getAllDiscoveriesFromFilesystem,
      });
    }

    return discoveries;
  } catch (error) {
    return fallbackOrThrow({
      message: "Convex discovery query failed",
      error,
      fallback: getAllDiscoveriesFromFilesystem,
    });
  }
}

export async function getDiscovery(slug: string) {
  "use cache";
  cacheLife("max");
  cacheTag("discoveries");
  cacheTag(`discovery:${slug}`);

  const convex = getConvexClient();
  if (!convex) {
    return fallbackOrThrow({
      message:
        `CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for discovery:${slug} reads (runtime filesystem fallback disabled)`,
      fallback: () => getDiscoveryFromFilesystem(slug),
    });
  }

  try {
    const doc = await convex.query(api.contentResources.getByResourceId, {
      resourceId: `discovery:${slug}`,
    });

    if (!doc || typeof doc !== "object") return null;

    const record = asRecord(doc);
    const docType = asOptionalString(record.type);
    if (docType && docType !== "discovery") return null;

    const fields = parseDiscoveryFields(record.fields, slug);
    if (!fields?.content) {
      return fallbackOrThrow({
        message: `Convex discovery:${slug} missing required fields/content`,
        fallback: () => getDiscoveryFromFilesystem(slug),
      });
    }

    return {
      meta: toDiscoveryMeta(fields),
      content: stripFirstH1(fields.content),
    };
  } catch (error) {
    return fallbackOrThrow({
      message: `Convex discovery query failed for slug ${slug}`,
      error,
      fallback: () => getDiscoveryFromFilesystem(slug),
    });
  }
}

export async function getDiscoverySlugs(): Promise<string[]> {
  "use cache";
  cacheLife("days");
  cacheTag("discoveries");

  const convex = getConvexClient();
  if (!convex) {
    return fallbackOrThrow({
      message:
        "CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for discovery slug reads (runtime filesystem fallback disabled)",
      fallback: getDiscoverySlugsFromFilesystem,
    });
  }

  try {
    const docs = await convex.query(api.contentResources.listByType, {
      type: "discovery",
      limit: 5000,
    });

    if (!Array.isArray(docs)) {
      return fallbackOrThrow({
        message: "Convex listByType returned a non-array payload for discovery slugs",
        fallback: getDiscoverySlugsFromFilesystem,
      });
    }

    const slugs = docs
      .map((doc) => {
        const record = asRecord(doc);
        const fields = parseDiscoveryFields(
          record.fields,
          slugFromResourceId(record.resourceId),
        );
        return fields?.slug;
      })
      .filter((entry): entry is string => Boolean(entry));

    if (docs.length > 0 && slugs.length === 0) {
      return fallbackOrThrow({
        message: "Convex returned discovery docs but none produced usable slugs",
        fallback: getDiscoverySlugsFromFilesystem,
      });
    }

    return Array.from(new Set(slugs));
  } catch (error) {
    return fallbackOrThrow({
      message: "Convex discovery slug query failed",
      error,
      fallback: getDiscoverySlugsFromFilesystem,
    });
  }
}
