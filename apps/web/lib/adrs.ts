import { ConvexHttpClient } from "convex/browser";
import { cacheLife, cacheTag } from "next/cache";
import { api } from "@/convex/_generated/api";
import { toDateString } from "./date";

/**
 * ADR reader — Convex-only (ADR-0168).
 * No filesystem fallback. Vault is write-side, Convex is read-side.
 */

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

const CONVEX_URL =
  process.env.CONVEX_URL?.trim() ??
  process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ??
  "";

let convexClient: ConvexHttpClient | null | undefined;

const VALID_STATUSES = [
  "proposed",
  "accepted",
  "shipped",
  "implementing",
  "implemented",
  "deferred",
  "in_progress",
  "researching",
  "superseded",
  "deprecated",
  "rejected",
  "withdrawn",
] as const;

function getConvexClient(): ConvexHttpClient {
  if (convexClient) return convexClient;
  if (!CONVEX_URL) {
    throw new Error(
      "CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for ADR reads (ADR-0168: Convex is canonical)",
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

function slugFromResourceId(value: unknown): string | undefined {
  const raw = asOptionalString(value);
  if (!raw?.startsWith("adr:")) return undefined;
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

function extractTitle(content: string): string {
  const h1 = content.match(/^#\s+(?:ADR-\d+:\s*)?(.+)$/m);
  return h1?.[1]?.trim() ?? "Untitled";
}

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
    ?? (content ? extractTitle(content) : undefined)
    ?? `ADR-${numberFromSlug(slug) || ""}`;
  const date = toDateString(fields.date) || (content ? extractDateFromContent(content) : "") || "Unknown";
  if (!title) return null;

  return {
    title,
    date,
    status: normalizeStatus(fields.status),
    slug,
    number: asOptionalString(fields.number) ?? numberFromSlug(slug),
    supersededBy: asOptionalString(fields.supersededBy) ?? asOptionalString(fields["superseded-by"]),
    description: asOptionalString(fields.description) ?? (content ? extractDescription(content) : undefined),
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

export async function getAllAdrs(): Promise<AdrMeta[]> {
  "use cache";
  cacheLife("days");
  cacheTag("adrs");

  const convex = getConvexClient();
  const docs = await convex.query(api.contentResources.listByType, {
    type: "adr",
    limit: 5000,
  });

  if (!Array.isArray(docs)) {
    throw new Error("Convex listByType returned a non-array payload for ADRs");
  }

  return docs
    .map((doc) => {
      const record = asRecord(doc);
      const fields = parseAdrFields(record.fields, slugFromResourceId(record.resourceId));
      if (!fields) return null;
      return toAdrMeta(fields);
    })
    .filter((adr): adr is AdrMeta => adr !== null)
    .sort(sortByAdrNumberDesc);
}

export async function getAdr(slug: string) {
  "use cache";
  cacheLife("max");
  cacheTag("adrs");
  cacheTag(`adr:${slug}`);

  const convex = getConvexClient();
  const doc = await convex.query(api.contentResources.getByResourceId, {
    resourceId: `adr:${slug}`,
  });

  if (!doc || typeof doc !== "object") return null;

  const record = asRecord(doc);
  const docType = asOptionalString(record.type);
  if (docType && docType !== "adr") return null;

  const fields = parseAdrFields(record.fields, slug);
  if (!fields?.content) return null;

  return {
    meta: toAdrMeta(fields),
    content: fields.content,
  };
}

export async function getAdrSlugs(): Promise<string[]> {
  "use cache";
  cacheLife("days");
  cacheTag("adrs");

  const convex = getConvexClient();
  const docs = await convex.query(api.contentResources.listByType, {
    type: "adr",
    limit: 5000,
  });

  if (!Array.isArray(docs)) {
    throw new Error("Convex listByType returned a non-array payload for ADR slugs");
  }

  return docs
    .map((doc) => {
      const record = asRecord(doc);
      const fields = parseAdrFields(record.fields, slugFromResourceId(record.resourceId));
      return fields?.slug;
    })
    .filter((entry): entry is string => Boolean(entry));
}
