import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { upsertAdr, upsertPost, type ConvexSyncResult } from "../../lib/convex-content-sync";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

/**
 * Vault source directories — canonical write-side for content.
 * ADR-0168: Vault is write-side, Convex is read-side, repo holds zero content.
 */
const CONTENT_SOURCES = [
  {
    name: "adrs",
    vaultDir: "/Users/joel/Vault/docs/decisions/",
    extension: ".md",
    skipFiles: ["readme.md"],
  },
  // Posts are authored via Convex directly (joelclaw-web skill, publish flow).
  // No Vault source for posts — they live in Convex as canonical.
  // Add a Vault source here if posts move to Vault authoring.
] as const;

function listSourceFiles(dir: string, extension: string, skipFiles: readonly string[]): string[] {
  try {
    const skipLower = skipFiles.map((f) => f.toLowerCase());
    return readdirSync(dir)
      .filter((f) => extname(f) === extension && !skipLower.includes(f.toLowerCase()))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

type SyncDirResult = {
  name: string;
  sourceCount: number;
  upserted: number;
  errors: string[];
};

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
        const files = listSourceFiles(source.vaultDir, source.extension, source.skipFiles);
        const result: SyncDirResult = {
          name: source.name,
          sourceCount: files.length,
          upserted: 0,
          errors: [],
        };

        for (const filePath of files) {
          try {
            if (source.extension === ".md") {
              await upsertAdr(filePath);
            } else if (source.extension === ".mdx") {
              const upserted = await upsertPost(filePath);
              if (!upserted) continue; // draft, skip count
            }
            result.upserted++;
          } catch (err) {
            result.errors.push(`${basename(filePath)}: ${String(err)}`);
          }
        }

        out.push(result);
      }

      return out;
    });

    const totalUpserted = results.reduce((sum, r) => sum + r.upserted, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    // Log summary
    for (const r of results) {
      console.log(`[content-sync] ${r.name}: ${r.upserted}/${r.sourceCount} upserted, ${r.errors.length} errors`);
    }
    console.log(`[content-sync] done — ${totalUpserted} upserted, ${totalErrors} errors`);

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
          totalErrors,
          content: results.map((r) => ({
            name: r.name,
            sourceCount: r.sourceCount,
            upserted: r.upserted,
            errorCount: r.errors.length,
            errors: r.errors.slice(0, 5), // cap logged errors
          })),
        },
      });
    });

    return {
      status: "completed",
      totalUpserted,
      totalErrors,
      content: results.map((r) => ({
        name: r.name,
        sourceCount: r.sourceCount,
        upserted: r.upserted,
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
    const gaps = await step.run("verify-content", async () => {
      const { ConvexHttpClient } = await import("convex/browser");
      const { anyApi } = await import("convex/server");

      const convexUrl =
        process.env.CONVEX_URL?.trim() ||
        process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ||
        "https://tough-panda-917.convex.cloud";
      const client = new ConvexHttpClient(convexUrl);

      // biome-ignore lint/suspicious/noExplicitAny: convex anyApi typing
      const listRef = (anyApi as any).contentResources.listByType;

      const report: {
        name: string;
        vaultCount: number;
        convexCount: number;
        missingInConvex: string[];
        extraInConvex: string[];
      }[] = [];

      // Check ADRs
      const adrFiles = listSourceFiles(
        CONTENT_SOURCES[0].vaultDir,
        CONTENT_SOURCES[0].extension,
        CONTENT_SOURCES[0].skipFiles,
      ).map((f) => basename(f, ".md"));

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
        missingInConvex: adrFiles.filter((s) => !adrSlugs.has(s)),
        extraInConvex: [...adrSlugs].filter((s) => !adrFiles.includes(s)),
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
    });

    const healthy = gaps.every((g) => g.missingInConvex.length === 0);

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
