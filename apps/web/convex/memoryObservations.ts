import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/** List observations, newest first. Optional category filter. */
export const list = query({
  args: {
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { category, limit = 50 }) => {
    let q = ctx.db.query("memoryObservations").withIndex("by_timestamp").order("desc");
    const all = await q.collect();
    const filtered = category ? all.filter((o) => o.category === category) : all;
    return filtered.slice(0, limit);
  },
});

/** Search observations by text. */
export const search = query({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { query: q, limit = 50 }) => {
    return ctx.db
      .query("memoryObservations")
      .withSearchIndex("search_observation", (s) => s.search("observation", q))
      .take(limit);
  },
});

/** Upsert an observation (idempotent by observationId). */
export const upsert = mutation({
  args: {
    observationId: v.string(),
    observation: v.string(),
    category: v.string(),
    source: v.string(),
    sessionId: v.optional(v.string()),
    superseded: v.boolean(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("memoryObservations")
      .withIndex("by_observationId", (q) => q.eq("observationId", args.observationId))
      .first();

    const doc = { ...args, syncedAt: Date.now() / 1000 };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("memoryObservations", doc);
    }
  },
});
