#!/usr/bin/env bun

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { api } from "../apps/web/convex/_generated/api";
import { ConvexHttpClient } from "../apps/web/node_modules/convex/browser";
import type { FunctionReference } from "../apps/web/node_modules/convex/server";
import matter from "../apps/web/node_modules/gray-matter";

type AdrFields = {
  slug: string;
  title: string;
  number: string;
  status: string;
  date: string;
  supersededBy?: string;
  description?: string;
  content: string;
};

type DiscoveryFields = {
  slug: string;
  title: string;
  source: string;
  discovered: string;
  tags: string[];
  relevance: string;
  content: string;
};

type UpsertResult = {
  action?: "inserted" | "updated";
  resourceId?: string;
};

type ContentResourceDocument = {
  type?: unknown;
  fields?: unknown;
};

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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function toDateString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function normalizeStatus(raw: unknown): string {
  if (typeof raw !== "string") return "proposed";
  const lower = raw.toLowerCase().trim().replace(/-/g, "_");
  for (const status of VALID_STATUSES) {
    if (lower === status || lower.startsWith(status)) return status;
  }
  return "proposed";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractH1(content: string): string | undefined {
  const h1 = content.match(/^#\s+(?:ADR-\d+:\s*)?(.+)$/m);
  return h1?.[1]?.trim();
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

function readEnvValueFromFile(filePath: string, key: string): string | undefined {
  let file: string;
  try {
    file = readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  for (const rawLine of file.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== key) continue;
    const value = match[2]?.trim() ?? "";
    const unquoted = value.replace(/^['"]|['"]$/g, "").trim();
    if (unquoted.length > 0) return unquoted;
  }

  return undefined;
}

function resolveConvexUrl(repoRoot: string): string {
  const fromEnvCandidates = [
    process.env.CONVEX_URL?.trim(),
    process.env.NEXT_PUBLIC_CONVEX_URL?.trim(),
    process.env.CONVEX_SELF_HOSTED_URL?.trim(),
  ];

  for (const candidate of fromEnvCandidates) {
    if (candidate && candidate.length > 0) return candidate;
  }

  const envCandidates = [
    join(repoRoot, "apps", "web", ".env.local"),
    join(repoRoot, "apps", "web", ".env"),
  ];

  for (const filePath of envCandidates) {
    const fileCandidates = [
      readEnvValueFromFile(filePath, "CONVEX_URL"),
      readEnvValueFromFile(filePath, "NEXT_PUBLIC_CONVEX_URL"),
      readEnvValueFromFile(filePath, "CONVEX_SELF_HOSTED_URL"),
    ];
    for (const candidate of fileCandidates) {
      if (candidate) return candidate;
    }
  }

  return "";
}

function resolveConvexAdminAuth(repoRoot: string): string | null {
  const fromEnvCandidates = [
    process.env.CONVEX_DEPLOY_KEY?.trim(),
    process.env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim(),
  ];
  for (const candidate of fromEnvCandidates) {
    if (candidate && candidate.length > 0) return candidate;
  }

  const envCandidates = [
    join(repoRoot, "apps", "web", ".env.local"),
    join(repoRoot, "apps", "web", ".env"),
  ];

  for (const filePath of envCandidates) {
    const fileValue =
      readEnvValueFromFile(filePath, "CONVEX_DEPLOY_KEY")
      ?? readEnvValueFromFile(filePath, "CONVEX_SELF_HOSTED_ADMIN_KEY");
    if (fileValue) return fileValue;
  }

  return null;
}

function buildAdrSearchText(fields: AdrFields): string {
  return [
    fields.slug,
    fields.number,
    fields.title,
    fields.status,
    fields.date,
    fields.supersededBy,
    fields.description,
    fields.content,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

function buildDiscoverySearchText(fields: DiscoveryFields): string {
  return [
    fields.slug,
    fields.title,
    fields.source,
    fields.discovered,
    fields.tags.join(" "),
    fields.relevance,
    fields.content,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

async function upsertAndVerify(
  convex: ConvexHttpClient,
  upsertRef: FunctionReference<"mutation">,
  getByResourceIdRef: FunctionReference<"query">,
  args: {
    resourceId: string;
    type: "adr" | "discovery";
    fields: AdrFields | DiscoveryFields;
    searchText: string;
  },
): Promise<"inserted" | "updated"> {
  const before = (await convex.query(getByResourceIdRef, {
    resourceId: args.resourceId,
  })) as ContentResourceDocument | null;

  const result = (await convex.mutation(upsertRef, args)) as UpsertResult;
  const action: "inserted" | "updated" = result.action ?? (before ? "updated" : "inserted");

  const after = (await convex.query(getByResourceIdRef, {
    resourceId: args.resourceId,
  })) as ContentResourceDocument | null;

  if (!after) {
    throw new Error(`verification failed: ${args.resourceId} missing after upsert`);
  }
  if (after.type !== args.type) {
    throw new Error(`verification failed: ${args.resourceId} expected type ${args.type}`);
  }

  return action;
}

async function main() {
  const repoRoot = resolve(import.meta.dir, "..");
  const convexUrl = resolveConvexUrl(repoRoot);
  const adminAuth = resolveConvexAdminAuth(repoRoot);

  if (!convexUrl) {
    throw new Error(
      "CONVEX_URL, NEXT_PUBLIC_CONVEX_URL, or CONVEX_SELF_HOSTED_URL is required to seed ADR/discovery resources.",
    );
  }

  const adrsDir = join(repoRoot, "apps", "web", "content", "adrs");
  const discoveriesDir = join(repoRoot, "apps", "web", "content", "discoveries");

  const adrFiles = readdirSync(adrsDir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort((a, b) => a.localeCompare(b));

  const discoveryFiles = readdirSync(discoveriesDir)
    .filter((name) => name.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));

  const convex = new ConvexHttpClient(convexUrl);
  if (adminAuth) convex.setAdminAuth(adminAuth);

  const upsertRef = api.contentResources.upsert as FunctionReference<"mutation">;
  const getByResourceIdRef = api.contentResources.getByResourceId as FunctionReference<"query">;

  try {
    await convex.query(getByResourceIdRef, { resourceId: "__seed_probe__" });
  } catch (error) {
    throw new Error(
      `[seed-adrs-discoveries] Convex query probe failed at ${convexUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let adrInserted = 0;
  let adrUpdated = 0;

  for (const filename of adrFiles) {
    const slug = filename.replace(/\.md$/, "");
    const number = slug.match(/^(\d+)/)?.[1] ?? "";
    const raw = readFileSync(join(adrsDir, filename), "utf-8");
    const { data, content } = matter(raw);

    const fields: AdrFields = {
      slug,
      number,
      title: asString(data.title) ?? extractH1(content) ?? `ADR-${number}`,
      status: normalizeStatus(data.status),
      date: toDateString(data.date),
      supersededBy: asString(data["superseded-by"]) ?? asString(data.supersededBy),
      description: asString(data.description) ?? extractAdrDescription(content),
      content,
    };

    const action = await upsertAndVerify(convex, upsertRef, getByResourceIdRef, {
      resourceId: `adr:${slug}`,
      type: "adr",
      fields,
      searchText: buildAdrSearchText(fields),
    });

    if (action === "inserted") adrInserted += 1;
    if (action === "updated") adrUpdated += 1;

    console.log(`[seed-adrs-discoveries] adr:${slug} (${action})`);
  }

  let discoveryInserted = 0;
  let discoveryUpdated = 0;

  for (const filename of discoveryFiles) {
    const defaultSlug = slugify(filename.replace(/\.md$/, ""));
    const raw = readFileSync(join(discoveriesDir, filename), "utf-8");
    const { data, content } = matter(raw);

    const fields: DiscoveryFields = {
      slug: asString(data.slug) ?? defaultSlug,
      title: asString(data.title) ?? extractH1(content) ?? filename.replace(/\.md$/, ""),
      source: asString(data.source) ?? "",
      discovered: toDateString(data.discovered),
      tags: asStringArray(data.tags),
      relevance: asString(data.relevance) ?? "",
      content,
    };

    const action = await upsertAndVerify(convex, upsertRef, getByResourceIdRef, {
      resourceId: `discovery:${fields.slug}`,
      type: "discovery",
      fields,
      searchText: buildDiscoverySearchText(fields),
    });

    if (action === "inserted") discoveryInserted += 1;
    if (action === "updated") discoveryUpdated += 1;

    console.log(`[seed-adrs-discoveries] discovery:${fields.slug} (${action})`);
  }

  console.log(
    `[seed-adrs-discoveries] complete adr(inserted=${adrInserted}, updated=${adrUpdated}) discovery(inserted=${discoveryInserted}, updated=${discoveryUpdated})`,
  );
}

main().catch((error) => {
  console.error("[seed-adrs-discoveries] failed", error);
  process.exit(1);
});
