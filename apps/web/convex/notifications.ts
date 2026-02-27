import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/** Get recent notifications (newest first) */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return ctx.db
      .query("notifications")
      .withIndex("by_createdAt")
      .order("desc")
      .take(args.limit ?? 20);
  },
});

/** Get unread count */
export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const unread = await ctx.db
      .query("notifications")
      .filter((q) => q.eq(q.field("read"), false))
      .collect();
    return unread.length;
  },
});

/** Mark notification as read */
export const markRead = mutation({
  args: { id: v.id("notifications") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { read: true });
  },
});

/** Create a notification (called from Inngest via HTTP action) */
export const create = mutation({
  args: {
    type: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("notifications", {
      ...args,
      read: false,
      createdAt: Date.now(),
    });
  },
});
