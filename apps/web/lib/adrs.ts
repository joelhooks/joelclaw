import { ConvexHttpClient } from "convex/browser";
import fs from "fs";
import matter from "gray-matter";
import { cacheLife, cacheTag } from "next/cache";
import path from "path";
import { api } from "@/convex/_generated/api";
import { toDateString } from "./date";

export type AdrMeta = {
  title: string;
  date: string;
  status: string;
  slug: string;
  number: string;
  supersededBy?: string;
  description?: string;
};

type ParsedAdrFields = {
  title: string;
  date: string;
  status: string;
  slug: string;
  number: string;
  supersededBy?: string;
  description?: string;
  content?: string;
};

const adrDir = path.join(process.cwd(), "content", "adrs");

const CONVEX_URL =
  process.env.CONVEX_URL?.trim() ??
  process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ??
  "";

let convexClient: ConvexHttpClient | null | undefined;

/**
 * Canonical ADR statuses. Anything else gets normalized:
 * - "superseded by 0033" → "superseded"
 * - "accepted (partially superseded by 0003)" → "accepted"
 */
const VALID_STATUSES = [
  "proposed",
  "accepted",
  "shipped",
  "implemented",
  "deferred",
  "in_progress",
  "researching",
  "superseded",
  "deprecated",
  "rejected",
  "withdrawn",
] as const;

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

function throwAdrsError(message: string, error?: unknown): never {
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
    throwAdrsError(args.message, args.error);
  }

  console.warn(
    `[adrs] ${args.message}. Falling back to filesystem because JOELCLAW_ALLOW_FILESYSTEM_CONTENT_FALLBACK=1.`,
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

function slugFromResourceId(value: unknown): string | undefined {
  const raw = asOptionalString(value);
  if (!raw) return undefined;
  if (!raw.startsWith("adr:")) return undefined;
  const slug = raw.slice("adr:".length).trim();
  return slug.length > 0 ? slug : undefined;
}

function numberFromSlug(slug: string): string {
  return slug.match(/^(\d+)/)?.[1] ?? "";
}

function normalizeStatus(raw: unknown): string {
  if (typeof raw !== "string") return "proposed";
  const lower = raw.toLowerCase().trim().replace(/-/g, "_");
  for (const valid of VALID_STATUSES) {
    if (lower === valid || lower.startsWith(valid)) return valid;
  }
  return "proposed";
}

/** Extract title from frontmatter, falling back to the first H1 in the body */
function extractTitle(data: Record<string, unknown>, content: string): string {
  if (data.title && typeof data.title === "string") return data.title;
  const h1 = content.match(/^#\s+(?:ADR-\d+:\s*)?(.+)$/m);
  return h1?.[1]?.trim() ?? "Untitled";
}

/** Pull a one-liner from the Context section or first paragraph */
function extractDescription(content: string): string {
  const ctx = content.match(
    /## Context and Problem Statement\s+(.+?)(?:\n\n|\n##)/s,
  );
  const match = ctx?.[1];
  if (match) {
    const first = (match.split("\n\n")[0] ?? "").trim();
    return first.length > 200 ? `${first.slice(0, 197)}…` : first;
  }
  return "";
}

function extractDateFromContent(content: string): string {
  const match = content.match(/\*\*Date\*\*\s*[:：]\s*(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? "";
}

function parseAdrFields(value: unknown, fallbackSlug?: string): ParsedAdrFields | null {
  const fields = asRecord(value);

  const slug = asOptionalString(fields.slug) ?? fallbackSlug;
  if (!slug) return null;

  const content = asOptionalString(fields.content);
  const title =
    asOptionalString(fields.title)
    ?? (content ? extractTitle({}, content) : undefined)
    ?? `ADR-${numberFromSlug(slug) || ""}`;
  const date = toDateString(fields.date) || (content ? extractDateFromContent(content) : "") || "Unknown";
  if (!title) return null;

  const number = asOptionalString(fields.number) ?? numberFromSlug(slug);

  return {
    title,
    date,
    status: normalizeStatus(fields.status),
    slug,
    number,
    supersededBy: asOptionalString(fields.supersededBy) ?? asOptionalString(fields["superseded-by"]),
    description:
      asOptionalString(fields.description)
      ?? (content ? extractDescription(content) : undefined),
    content,
  };
}

function toAdrMeta(fields: ParsedAdrFields): AdrMeta {
  return {
    title: fields.title,
    date: fields.date,
    status: fields.status,
    slug: fields.slug,
    number: fields.number,
    supersededBy: fields.supersededBy,
    description: fields.description,
  };
}

function sortByAdrNumberDesc(a: AdrMeta, b: AdrMeta): number {
  return a.number > b.number ? -1 : 1;
}

function getAllAdrsFromFilesystem(): AdrMeta[] {
  if (!fs.existsSync(adrDir)) return [];
  const files = fs
    .readdirSync(adrDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md");

  return files
    .map((filename) => {
      const raw = fs.readFileSync(path.join(adrDir, filename), "utf-8");
      const { data, content } = matter(raw);
      const slug = filename.replace(/\.md$/, "");
      const number = numberFromSlug(slug);

      return {
        title: extractTitle(data, content),
        date: toDateString(data.date),
        status: normalizeStatus(data.status),
        slug,
        number,
        supersededBy:
          asOptionalString(data["superseded-by"])
          ?? asOptionalString(data.supersededBy),
        description: extractDescription(content),
      } satisfies AdrMeta;
    })
    .sort(sortByAdrNumberDesc);
}

function getAdrFromFilesystem(slug: string) {
  const filePath = path.join(adrDir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const number = numberFromSlug(slug);

  return {
    meta: {
      title: extractTitle(data, content),
      date: toDateString(data.date),
      status: normalizeStatus(data.status),
      slug,
      number,
      supersededBy:
        asOptionalString(data["superseded-by"])
        ?? asOptionalString(data.supersededBy),
      description: extractDescription(content),
    } satisfies AdrMeta,
    content,
  };
}

function getAdrSlugsFromFilesystem(): string[] {
  if (!fs.existsSync(adrDir)) return [];
  return fs
    .readdirSync(adrDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""));
}

export async function getAllAdrs(): Promise<AdrMeta[]> {
  "use cache";
  cacheLife("days");
  cacheTag("adrs");

  const convex = getConvexClient();
  if (!convex) {
    return fallbackOrThrow({
      message:
        "CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for ADR reads (runtime filesystem fallback disabled)",
      fallback: getAllAdrsFromFilesystem,
    });
  }

  try {
    const docs = await convex.query(api.contentResources.listByType, {
      type: "adr",
      limit: 5000,
    });

    if (!Array.isArray(docs)) {
      return fallbackOrThrow({
        message: "Convex listByType returned a non-array payload for ADRs",
        fallback: getAllAdrsFromFilesystem,
      });
    }

    const adrs = docs
      .map((doc) => {
        const record = asRecord(doc);
        const fields = parseAdrFields(record.fields, slugFromResourceId(record.resourceId));
        if (!fields) return null;
        return toAdrMeta(fields);
      })
      .filter((adr): adr is AdrMeta => adr !== null)
      .sort(sortByAdrNumberDesc);

    if (docs.length > 0 && adrs.length === 0) {
      return fallbackOrThrow({
        message: "Convex returned ADR docs but none passed schema parsing",
        fallback: getAllAdrsFromFilesystem,
      });
    }

    return adrs;
  } catch (error) {
    return fallbackOrThrow({
      message: "Convex ADR query failed",
      error,
      fallback: getAllAdrsFromFilesystem,
    });
  }
}

export async function getAdr(slug: string) {
  "use cache";
  cacheLife("max");
  cacheTag("adrs");
  cacheTag(`adr:${slug}`);

  const convex = getConvexClient();
  if (!convex) {
    return fallbackOrThrow({
      message:
        `CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for adr:${slug} reads (runtime filesystem fallback disabled)`,
      fallback: () => getAdrFromFilesystem(slug),
    });
  }

  try {
    const doc = await convex.query(api.contentResources.getByResourceId, {
      resourceId: `adr:${slug}`,
    });

    if (!doc || typeof doc !== "object") return null;

    const record = asRecord(doc);
    const docType = asOptionalString(record.type);
    if (docType && docType !== "adr") return null;

    const fields = parseAdrFields(record.fields, slug);
    if (!fields?.content) {
      return fallbackOrThrow({
        message: `Convex adr:${slug} missing required fields/content`,
        fallback: () => getAdrFromFilesystem(slug),
      });
    }

    return {
      meta: toAdrMeta(fields),
      content: fields.content,
    };
  } catch (error) {
    return fallbackOrThrow({
      message: `Convex ADR query failed for slug ${slug}`,
      error,
      fallback: () => getAdrFromFilesystem(slug),
    });
  }
}

export async function getAdrSlugs(): Promise<string[]> {
  "use cache";
  cacheLife("days");
  cacheTag("adrs");

  const convex = getConvexClient();
  if (!convex) {
    return fallbackOrThrow({
      message:
        "CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for ADR slug reads (runtime filesystem fallback disabled)",
      fallback: getAdrSlugsFromFilesystem,
    });
  }

  try {
    const docs = await convex.query(api.contentResources.listByType, {
      type: "adr",
      limit: 5000,
    });

    if (!Array.isArray(docs)) {
      return fallbackOrThrow({
        message: "Convex listByType returned a non-array payload for ADR slugs",
        fallback: getAdrSlugsFromFilesystem,
      });
    }

    const slugs = docs
      .map((doc) => {
        const record = asRecord(doc);
        const fields = parseAdrFields(record.fields, slugFromResourceId(record.resourceId));
        return fields?.slug;
      })
      .filter((entry): entry is string => Boolean(entry));

    if (docs.length > 0 && slugs.length === 0) {
      return fallbackOrThrow({
        message: "Convex returned ADR docs but none produced usable slugs",
        fallback: getAdrSlugsFromFilesystem,
      });
    }

    return Array.from(new Set(slugs));
  } catch (error) {
    return fallbackOrThrow({
      message: "Convex ADR slug query failed",
      error,
      fallback: getAdrSlugsFromFilesystem,
    });
  }
}
