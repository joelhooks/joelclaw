/**
 * Knowledge retrieval watchdog — verifies system_knowledge is actually
 * being used across all agent surfaces. Fires every 4h.
 *
 * Checks:
 * 1. OTEL events: any system_knowledge.retrieval in the window?
 * 2. system_knowledge collection: non-empty? stale?
 * 3. Recent loop dispatches without retrieval events → alert
 *
 * ADR-0199: Force/enforce/verify at every level.
 */

import { getRedisClient } from "../../lib/redis";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const WINDOW_HOURS = 4;
const KNOWLEDGE_WATCHDOG_LAST_RUN_KEY = "knowledge:watchdog:last_run";
const KNOWLEDGE_WATCHDOG_GATE_INTERVAL_MS = 3 * 60 * 60 * 1000;

export const knowledgeWatchdog = inngest.createFunction(
  {
    id: "knowledge-watchdog",
    retries: 2,
  },
  { cron: "0 */4 * * *" }, // Every 4 hours
  async ({ step }) => {
    const gate = await step.run("check-gate", async () => {
      const redis = getRedisClient();
      const now = Date.now();
      const lastRunRaw = await redis.get(KNOWLEDGE_WATCHDOG_LAST_RUN_KEY);
      const lastRunTimestamp = Number(lastRunRaw);

      if (
        Number.isFinite(lastRunTimestamp) &&
        lastRunTimestamp > 0 &&
        now - lastRunTimestamp < KNOWLEDGE_WATCHDOG_GATE_INTERVAL_MS
      ) {
        return {
          shouldRun: false as const,
          reason: "last run <3h ago" as const,
          lastRunTimestamp,
        };
      }

      return { shouldRun: true as const };
    });

    if (!gate.shouldRun) {
      return {
        status: "skipped" as const,
        reason: gate.reason,
        lastRunTimestamp: gate.lastRunTimestamp ?? null,
      };
    }

    const checks = await step.run("audit-knowledge-health", async () => {
      const now = Math.floor(Date.now() / 1000);
      const windowStart = now - WINDOW_HOURS * 3600;
      const issues: string[] = [];
      const stats: Record<string, unknown> = {};

      // 1. Collection exists and has docs?
      try {
        const resp = await fetch(
          `${typesense.TYPESENSE_URL}/collections/${typesense.SYSTEM_KNOWLEDGE_COLLECTION}`,
          { headers: { "X-TYPESENSE-API-KEY": process.env.TYPESENSE_API_KEY || "" } },
        );
        if (!resp.ok) {
          issues.push("system_knowledge collection MISSING");
          stats.collection_exists = false;
        } else {
          const coll = (await resp.json()) as { num_documents?: number };
          stats.collection_exists = true;
          stats.num_documents = coll.num_documents ?? 0;
          if ((coll.num_documents ?? 0) === 0) {
            issues.push("system_knowledge collection EMPTY (0 documents)");
          } else if ((coll.num_documents ?? 0) < 50) {
            issues.push(`system_knowledge suspiciously small: ${coll.num_documents} docs`);
          }
        }
      } catch (e) {
        issues.push(`Typesense unreachable: ${e}`);
        stats.collection_exists = false;
      }

      // 2. Recent OTEL retrieval events?
      try {
        const result = await typesense.search({
          collection: "otel_events",
          q: "system_knowledge.retrieval",
          query_by: "action",
          filter_by: `timestamp:>${windowStart}`,
          per_page: 1,
        });
        const retrievalCount = result.found ?? 0;
        stats.retrievals_in_window = retrievalCount;
        if (retrievalCount === 0) {
          // Only an issue if there WERE dispatches
          const dispatchResult = await typesense.search({
            collection: "otel_events",
            q: "agent dispatch implement",
            query_by: "action,component",
            filter_by: `timestamp:>${windowStart}`,
            per_page: 1,
          });
          const dispatches = dispatchResult.found ?? 0;
          stats.dispatches_in_window = dispatches;
          if (dispatches > 0) {
            issues.push(
              `${dispatches} agent dispatches with ZERO knowledge retrievals in ${WINDOW_HOURS}h`,
            );
          }
        }
      } catch {
        // OTEL search failed — not fatal, but note it
        stats.otel_search_error = true;
      }

      // 3. Check for stale content (no sync in 48h)
      try {
        const result = await typesense.search({
          collection: typesense.SYSTEM_KNOWLEDGE_COLLECTION,
          q: "*",
          query_by: "title,content",
          sort_by: "created_at:desc",
          per_page: 1,
        });
        if (result.hits?.[0]) {
          const doc = result.hits[0].document as { created_at?: number };
          const lastSync = doc.created_at ?? 0;
          const staleness = now - lastSync;
          stats.last_sync_age_hours = Math.round(staleness / 3600);
          if (staleness > 48 * 3600) {
            issues.push(`system_knowledge stale: last sync ${Math.round(staleness / 3600)}h ago`);
          }
        }
      } catch { /* graceful */ }

      return { issues, stats };
    });

    // Prune expired failed targets (>7 days old)
    const pruned = await step.run("prune-expired-failed-targets", async () => {
      const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
      try {
        const result = await typesense.search({
          collection: typesense.SYSTEM_KNOWLEDGE_COLLECTION,
          q: "*",
          query_by: "title,content",
          filter_by: `type:=failed_target && created_at:<${sevenDaysAgo}`,
          per_page: 100,
        });
        let deleted = 0;
        for (const hit of result.hits ?? []) {
          const doc = hit.document as { id?: string };
          if (!doc.id) continue;
          try {
            await fetch(
              `${typesense.TYPESENSE_URL}/collections/${typesense.SYSTEM_KNOWLEDGE_COLLECTION}/documents/${doc.id}`,
              { method: "DELETE", headers: { "X-TYPESENSE-API-KEY": process.env.TYPESENSE_API_KEY || "" } },
            );
            deleted++;
          } catch { /* skip */ }
        }
        return { pruned: deleted, found: result.found ?? 0 };
      } catch {
        return { pruned: 0, error: "search failed" };
      }
    });

    // Emit OTEL event for the watchdog itself
    await step.run("emit-watchdog-otel", () =>
      emitOtelEvent({
        action: "knowledge.watchdog.check",
        component: "knowledge-watchdog",
        source: "cron",
        success: checks.issues.length === 0,
        metadata: {
          ...checks.stats,
          issue_count: checks.issues.length,
          issues: checks.issues,
        },
      }),
    );

    // Alert if issues found
    if (checks.issues.length > 0) {
      await step.sendEvent("alert-knowledge-degraded", {
        name: "gateway/send.message" as any,
        data: {
          channel: "telegram",
          text: [
            "⚠️ <b>Knowledge Watchdog Alert</b>",
            "",
            ...checks.issues.map((i) => `• ${i}`),
            "",
            `<code>docs: ${checks.stats.num_documents ?? "?"} | retrievals: ${checks.stats.retrievals_in_window ?? "?"} | last sync: ${checks.stats.last_sync_age_hours ?? "?"}h ago</code>`,
          ].join("\n"),
          parse_mode: "HTML",
        },
      });
    }

    await step.run("record-last-run", async () => {
      const redis = getRedisClient();
      const now = Date.now();
      await redis.set(KNOWLEDGE_WATCHDOG_LAST_RUN_KEY, now.toString());
      return { key: KNOWLEDGE_WATCHDOG_LAST_RUN_KEY, timestamp: now };
    });

    return {
      healthy: checks.issues.length === 0,
      ...checks,
    };
  },
);
