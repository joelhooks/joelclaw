import fs from "fs";
import path from "path";
import matter from "gray-matter";
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

const adrDir = path.join(process.cwd(), "content", "adrs");

/**
 * Canonical ADR statuses. Anything else gets normalized:
 * - "superseded by 0033" → "superseded"
 * - "accepted (partially superseded by 0003)" → "accepted"
 * Raw "superseded-by" metadata is preserved separately.
 */
const VALID_STATUSES = [
  "proposed",
  "accepted",
  "implemented",
  "superseded",
  "deprecated",
  "rejected",
] as const;

function normalizeStatus(raw: unknown): string {
  if (typeof raw !== "string") return "proposed";
  const lower = raw.toLowerCase().trim();
  // Match against known statuses — take the first word that matches
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
    /## Context and Problem Statement\s+(.+?)(?:\n\n|\n##)/s
  );
  const match = ctx?.[1];
  if (match) {
    const first = (match.split("\n\n")[0] ?? "").trim();
    return first.length > 200 ? first.slice(0, 197) + "…" : first;
  }
  return "";
}

export function getAllAdrs(): AdrMeta[] {
  if (!fs.existsSync(adrDir)) return [];
  const files = fs
    .readdirSync(adrDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md");

  return files
    .map((filename) => {
      const raw = fs.readFileSync(path.join(adrDir, filename), "utf-8");
      const { data, content } = matter(raw);
      const slug = filename.replace(/\.md$/, "");
      const number = slug.match(/^(\d+)/)?.[1] ?? "";

      return {
        title: extractTitle(data, content),
        date: toDateString(data.date),
        status: normalizeStatus(data.status),
        slug,
        number,
        supersededBy: data["superseded-by"],
        description: extractDescription(content),
      };
    })
    .sort((a, b) => (a.number > b.number ? -1 : 1));
}

export function getAdr(slug: string) {
  const filePath = path.join(adrDir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const number = slug.match(/^(\d+)/)?.[1] ?? "";

  return {
    meta: {
      title: extractTitle(data, content),
      date: toDateString(data.date),
      status: normalizeStatus(data.status),
      slug,
      number,
      supersededBy: data["superseded-by"],
      description: extractDescription(content),
    } satisfies AdrMeta,
    content,
  };
}

export function getAdrSlugs(): string[] {
  if (!fs.existsSync(adrDir)) return [];
  return fs
    .readdirSync(adrDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""));
}
