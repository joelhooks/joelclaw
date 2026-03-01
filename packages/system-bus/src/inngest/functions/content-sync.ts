import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import matter from "gray-matter";
import { removeContentResources } from "../../lib/convex";
import { upsertAdr, upsertDiscovery, upsertPost } from "../../lib/convex-content-sync";
import { revalidateContentCache } from "../../lib/revalidate";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

/**
 * Vault source directories — canonical write-side for content.
 * ADR-0168: Vault is write-side, Convex is read-side, repo holds zero content.
 */
const ADR_FILENAME_PATTERN = /^\d{4}-.+\.md$/;

export function isCanonicalAdrFilename(fileName: string): boolean {
  return ADR_FILENAME_PATTERN.test(fileName);
}

const CONTENT_SOURCES = [
  {
    name: "adrs",
    vaultDir: "/Users/joel/Vault/docs/decisions/",
    extension: ".md",
    skipFiles: ["readme.md"],
    filePattern: ADR_FILENAME_PATTERN,
  },
  {
    name: "discoveries",
    vaultDir: "/Users/joel/Vault/Resources/discoveries/",
    extension: ".md",
    skipFiles: [],
    filePattern: undefined,
  },
  // Posts are authored via Convex directly (joelclaw-web skill, publish flow).
  // No Vault source for posts — they live in Convex as canonical.
  // Add a Vault source here if posts move to Vault authoring.
] as const;

function listSourceFiles(
  dir: string,
  extension: string,
  skipFiles: readonly string[],
  filePattern?: RegExp,
): string[] {
  try {
    const skipLower = skipFiles.map((f) => f.toLowerCase());
    return readdirSync(dir)
      .filter((f) => {
        if (extname(f) !== extension) return false;
        if (skipLower.includes(f.toLowerCase())) return false;
        if (filePattern && !filePattern.test(f)) return false;
        return true;
      })
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function readDiscoverySlug(filePath: string): string {
  const fallback = basename(filePath, ".md");
  try {
    const raw = readFileSync(filePath, "utf-8");
    const { data } = matter(raw);
    return typeof data.slug === "string" && data.slug.trim().length > 0
      ? data.slug.trim()
      : fallback;
  } catch {
    return fallback;
  }
}

type SyncDirResult = {
  name: string;
  sourceCount: number;
  upserted: number;
  skipped: number;
  errors: string[];
  writtenSlugs: string[];
};

export type ContentGapResult = {
  name: string;
  vaultCount: number;
  convexCount: number;
  missingInConvex: string[];
  extraInConvex: string[];
};

export function isContentGapHealthy(gap: ContentGapResult): boolean {
  if (gap.name === "adrs") {
    return gap.missingInConvex.length === 0 && gap.extraInConvex.length === 0;
  }
  return gap.missingInConvex.length === 0;
}

export function isContentVerifyHealthy(gaps: readonly ContentGapResult[]): boolean {
  return gaps.every(isContentGapHealthy);
}

function adrExtraSlugsFromGaps(gaps: readonly ContentGapResult[]): string[] {
  return gaps.find((gap) => gap.name === "adrs")?.extraInConvex ?? [];
}

export function adrExtraResourceIdsFromGaps(gaps: readonly ContentGapResult[]): string[] {
  return adrExtraSlugsFromGaps(gaps).map((slug) => `adr:${slug}`);
}

async function collectContentGaps(): Promise<ContentGapResult[]> {
  const { ConvexHttpClient } = await import("convex/browser");
  const { anyApi } = await import("convex/server");

  const convexUrl =
    process.env.CONVEX_URL?.trim() ||
    process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ||
    "https://tough-panda-917.convex.cloud";
  const client = new ConvexHttpClient(convexUrl);

  const listRef = (anyApi as any).contentResources.listByType;

  const report: ContentGapResult[] = [];

  // Check ADRs
  const adrSource = CONTENT_SOURCES.find((source) => source.name === "adrs");
  if (!adrSource) throw new Error("Missing content source configuration for adrs");

  const adrFiles = listSourceFiles(
    adrSource.vaultDir,
    adrSource.extension,
    adrSource.skipFiles,
    adrSource.filePattern,
  ).map((f) => basename(f, ".md"));
  const adrFileSet = new Set(adrFiles);

  const adrDocs = await client.query(listRef, { type: "adr", limit: 5000 });
  const adrSlugs = new Set(
    (Array.isArray(adrDocs) ? adrDocs : [])
      .map((d: any) => d.fields?.slug)
      .filter(Boolean) as string[],
  );

  report.push({
    name: "adrs",
    vaultCount: adrFiles.length,
    convexCount: adrSlugs.size,
    missingInConvex: adrFiles.filter((slug) => !adrSlugs.has(slug)),
    extraInConvex: [...adrSlugs].filter((slug) => !adrFileSet.has(slug)),
  });

  // Check discoveries
  const discoverySource = CONTENT_SOURCES.find((source) => source.name === "discoveries");
  if (!discoverySource) throw new Error("Missing content source configuration for discoveries");

  const discoveryFiles = listSourceFiles(
    discoverySource.vaultDir,
    discoverySource.extension,
    discoverySource.skipFiles,
    discoverySource.filePattern,
  ).map(readDiscoverySlug);
  const discoveryFileSet = new Set(discoveryFiles);

  const discoveryDocs = await client.query(listRef, { type: "discovery", limit: 5000 });
  const discoverySlugs = new Set(
    (Array.isArray(discoveryDocs) ? discoveryDocs : [])
      .map((d: any) => d.fields?.slug)
      .filter(Boolean) as string[],
  );

  report.push({
    name: "discoveries",
    vaultCount: discoveryFiles.length,
    convexCount: discoverySlugs.size,
    missingInConvex: discoveryFiles.filter((slug) => !discoverySlugs.has(slug)),
    extraInConvex: [...discoverySlugs].filter((slug) => !discoveryFileSet.has(slug)),
  });

  // Posts are Convex-canonical (no Vault source). Just report count.
  const postDocs = await client.query(listRef, { type: "article", limit: 5000 });
  const postSlugs = new Set(
    (Array.isArray(postDocs) ? postDocs : [])
      .map((d: any) => d.fields?.slug)
      .filter(Boolean) as string[],
  );

  report.push({
    name: "posts",
    vaultCount: postSlugs.size, // posts are Convex-canonical, no vault source
    convexCount: postSlugs.size,
    missingInConvex: [],
    extraInConvex: [],
  });

  return report;
}

/**
 * Content sync — Vault → Convex direct.
 *
 * ADR-0168: No repo file copies, no git commits. Reads Vault source dirs,
 * parses frontmatter, upserts to Convex. Production web reads Convex exclusively.
 *
 * Triggers:
 * - Hourly cron (safety net)
 * - content/updated (after edits)
 * - content/seed.requested (full reseed from CLI)
 * - discovery/captured (after discovery-capture writes a vault note)
 * - system/adr.sync.requested (after ADR edits)
 */
export const contentSync = inngest.createFunction(
  {
    id: "system/content-sync",
    retries: 1,
    concurrency: { limit: 1, key: "content-sync" },
    debounce: { period: "45s", timeout: "3m", key: '"vault-sync"' },
  },
  [
    { cron: "0 * * * *" },
    { event: "content/updated" },
    { event: "content/seed.requested" },
    { event: "discovery/captured" },
    { event: "system/adr.sync.requested" },
  ],
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as
      | import("../middleware/gateway").GatewayContext
      | undefined;

    console.log(`[content-sync] started via ${event.name} at ${new Date().toISOString()}`);

    await step.run("otel-start", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "content-sync",
        action: "content_sync.started",
        success: true,
        metadata: { trigger: event.name },
      });
    });

    // Upsert all content sources to Convex
    const results: SyncDirResult[] = await step.run("upsert-to-convex", async () => {
      const out: SyncDirResult[] = [];

      for (const source of CONTENT_SOURCES) {
        const files = listSourceFiles(
          source.vaultDir,
          source.extension,
          source.skipFiles,
          source.filePattern,
        );
        const result: SyncDirResult = {
          name: source.name,
          sourceCount: files.length,
          upserted: 0,
          skipped: 0,
          errors: [],
          writtenSlugs: [],
        };

        for (const filePath of files) {
          try {
            let action: string;
            if (source.name === "adrs") {
              action = await upsertAdr(filePath);
            } else if (source.name === "discoveries") {
              action = await upsertDiscovery(filePath);
            } else if (source.extension === ".mdx") {
              action = await upsertPost(filePath);
            } else {
              continue;
            }
            if (action === "skipped" || action === "draft" || action === "private") {
              result.skipped++;
            } else {
              result.upserted++;
              if (source.name === "discoveries") {
                result.writtenSlugs.push(readDiscoverySlug(filePath));
              } else {
                result.writtenSlugs.push(basename(filePath, extname(filePath)));
              }
            }
          } catch (err) {
            result.errors.push(`${basename(filePath)}: ${String(err)}`);
          }
        }

        out.push(result);
      }

      return out;
    });

    // Remove private discoveries from Convex (prevents republishing)
    const privateRemoved = await step.run("remove-private-discoveries", async () => {
      const discoverySource = CONTENT_SOURCES.find((s) => s.name === "discoveries");
      if (!discoverySource) return 0;
      const files = listSourceFiles(
        discoverySource.vaultDir,
        discoverySource.extension,
        discoverySource.skipFiles,
        discoverySource.filePattern,
      );
      const privateResourceIds: string[] = [];
      for (const filePath of files) {
        try {
          const raw = readFileSync(filePath, "utf-8");
          const { data } = matter(raw);
          if (data.private === true) {
            const slug = typeof data.slug === "string" && data.slug.trim().length > 0
              ? data.slug.trim()
              : basename(filePath, ".md");
            privateResourceIds.push(`discovery:${slug}`);
          }
        } catch {}
      }
      if (privateResourceIds.length > 0) {
        await removeContentResources(privateResourceIds);
        console.log(`[content-sync] removed ${privateResourceIds.length} private discoveries from Convex`);
      }
      return privateResourceIds.length;
    });

    const totalUpserted = results.reduce((sum, r) => sum + r.upserted, 0);
    const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    // Log summary
    for (const r of results) {
      console.log(`[content-sync] ${r.name}: ${r.upserted} written, ${r.skipped} unchanged, ${r.errors.length} errors (${r.sourceCount} sources)`);
    }
    console.log(`[content-sync] done — ${totalUpserted} written, ${totalSkipped} unchanged, ${totalErrors} errors`);

    // Revalidate Next.js cache for changed content
    if (totalUpserted > 0) {
      await step.run("revalidate-cache", async () => {
        const tags: string[] = [];
        for (const r of results) {
          if (r.writtenSlugs.length === 0) continue;
          if (r.name === "adrs") {
            tags.push("adrs");
            for (const slug of r.writtenSlugs) {
              tags.push(`adr:${slug}`);
            }
          } else if (r.name === "discoveries") {
            tags.push("discoveries");
            for (const slug of r.writtenSlugs) {
              tags.push(`discovery:${slug}`);
            }
          } else if (r.name === "posts") {
            tags.push("articles");
            for (const slug of r.writtenSlugs) {
              tags.push(`post:${slug}`, `article:${slug}`);
            }
          }
        }
        const result = await revalidateContentCache({ tags });
        console.log(`[content-sync] revalidated ${result.tags.length} cache tags`);
        return result;
      });
    }

    // Notify gateway
    if (totalUpserted > 0 && gateway) {
      await step.run("notify-gateway", async () => {
        try {
          const summary = results
            .filter((r) => r.upserted > 0)
            .map((r) => `${r.name}: ${r.upserted}`)
            .join(", ");
          await gateway.notify("content.synced", {
            upserted: totalUpserted,
            errors: totalErrors,
            summary,
          });
        } catch {}
      });
    }

    // OTEL finish
    await step.run("otel-finish", async () => {
      await emitOtelEvent({
        level: totalErrors > 0 ? "warn" : "info",
        source: "worker",
        component: "content-sync",
        action: "content_sync.completed",
        success: totalErrors === 0,
        error: totalErrors > 0 ? `${totalErrors} upsert errors` : undefined,
        metadata: {
          trigger: event.name,
          totalUpserted,
          totalSkipped,
          totalErrors,
          content: results.map((r) => ({
            name: r.name,
            sourceCount: r.sourceCount,
            upserted: r.upserted,
            skipped: r.skipped,
            errorCount: r.errors.length,
            errors: r.errors.slice(0, 5), // cap logged errors
          })),
        },
      });
    });

    return {
      status: "completed",
      totalUpserted,
      totalSkipped,
      totalErrors,
      content: results.map((r) => ({
        name: r.name,
        sourceCount: r.sourceCount,
        upserted: r.upserted,
        skipped: r.skipped,
        errors: r.errors,
      })),
    };
  },
);

/**
 * Content verify — diff Vault source files vs Convex records.
 * Reports gaps in either direction.
 */
export const contentVerify = inngest.createFunction(
  {
    id: "system/content-verify",
    retries: 1,
    concurrency: { limit: 1, key: "content-verify" },
  },
  { event: "content/verify.requested" },
  async ({ step }) => {
    const gaps = await step.run("verify-content", collectContentGaps);

    const healthy = isContentVerifyHealthy(gaps);

    await step.run("otel-verify", async () => {
      await emitOtelEvent({
        level: healthy ? "info" : "warn",
        source: "worker",
        component: "content-sync",
        action: "content_verify.completed",
        success: healthy,
        error: healthy ? undefined : "gaps_found",
        metadata: { gaps },
      });
    });

    return { status: healthy ? "healthy" : "gaps_found", gaps };
  },
);

/**
 * Content prune — remove ADR records from Convex that no longer exist in Vault.
 * Dry-run by default to prevent accidental deletes.
 */
export const contentPrune = inngest.createFunction(
  {
    id: "system/content-prune",
    retries: 1,
    concurrency: { limit: 1, key: "content-prune" },
  },
  { event: "content/prune.requested" },
  async ({ event, step }) => {
    const apply = event.data?.apply === true;
    const source =
      typeof event.data?.source === "string" && event.data.source.trim().length > 0
        ? event.data.source.trim()
        : "unknown";

    const gaps = await step.run("collect-content-gaps", collectContentGaps);
    const extraResourceIds = adrExtraResourceIdsFromGaps(gaps);

    const removedResourceIds = apply
      ? await step.run("remove-adr-extras", async () => {
          if (extraResourceIds.length === 0) return [];
          await removeContentResources(extraResourceIds);
          return extraResourceIds;
        })
      : [];

    if (removedResourceIds.length > 0) {
      await step.run("revalidate-pruned-cache", async () => {
        const tags = ["adrs", ...removedResourceIds];
        return revalidateContentCache({ tags });
      });
    }

    const status =
      extraResourceIds.length === 0 ? "clean" : apply ? "pruned" : "dry_run";

    await step.run("otel-prune", async () => {
      await emitOtelEvent({
        level: extraResourceIds.length === 0 ? "info" : "warn",
        source: "worker",
        component: "content-sync",
        action: "content_prune.completed",
        success: true,
        metadata: {
          source,
          apply,
          status,
          totalExtras: extraResourceIds.length,
          totalRemoved: removedResourceIds.length,
          extraResourceIds,
          removedResourceIds,
          gaps,
        },
      });
    });

    return {
      status,
      apply,
      source,
      totalExtras: extraResourceIds.length,
      totalRemoved: removedResourceIds.length,
      extraResourceIds,
      removedResourceIds,
      gaps,
    };
  },
);
