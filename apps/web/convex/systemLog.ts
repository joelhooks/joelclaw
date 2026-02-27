import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/** List log entries, newest first. Optional tool filter. */
export const list = query({
  args: {
    tool: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { tool, limit = 50 }) => {
    let q = ctx.db.query("systemLog").withIndex("by_timestamp").order("desc");
    const all = await q.collect();
    const filtered = tool ? all.filter((e) => e.tool === tool) : all;
    return filtered.slice(0, limit);
  },
});

/** Search log entries by detail text. */
export const search = query({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { query: q, limit = 50 }) => {
    return ctx.db
      .query("systemLog")
      .withSearchIndex("search_detail", (s) => s.search("detail", q))
      .take(limit);
  },
});

/** Upsert a log entry (idempotent by entryId). */
export const upsert = mutation({
  args: {
    entryId: v.string(),
    action: v.string(),
    tool: v.string(),
    detail: v.string(),
    reason: v.optional(v.string()),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("systemLog")
      .withIndex("by_entryId", (q) => q.eq("entryId", args.entryId))
      .first();

    const doc = { ...args, syncedAt: Date.now() / 1000 };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("systemLog", doc);
    }
  },
});
