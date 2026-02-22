import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/** Get latest status for all components */
export const list = query({
  args: {},
  handler: async (ctx) => {
    // Get all unique components with latest status
    const all = await ctx.db.query("systemStatus").collect();
    const latest = new Map<string, typeof all[0]>();
    for (const s of all) {
      const existing = latest.get(s.component);
      if (!existing || s.checkedAt > existing.checkedAt) {
        latest.set(s.component, s);
      }
    }
    return Array.from(latest.values());
  },
});

/** Upsert component status (called from Inngest heartbeat) */
export const upsert = mutation({
  args: {
    component: v.string(),
    status: v.union(v.literal("healthy"), v.literal("degraded"), v.literal("down")),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Find existing entry for this component
    const existing = await ctx.db
      .query("systemStatus")
      .withIndex("by_component", (q) => q.eq("component", args.component))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        detail: args.detail,
        checkedAt: Date.now(),
      });
      return existing._id;
    }

    return ctx.db.insert("systemStatus", {
      ...args,
      checkedAt: Date.now(),
    });
  },
});
