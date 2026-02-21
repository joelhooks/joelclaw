import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getByResourceId = query({
  args: { resourceId: v.string() },
  handler: async (ctx, { resourceId }) => {
    const doc = await ctx.db
      .query("contentResources")
      .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
      .first();

    if (!doc || doc.deletedAt !== undefined) return null;
    return doc;
  },
});

export const listByType = query({
  args: {
    type: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { type, limit = 100 }) => {
    const docs = await ctx.db
      .query("contentResources")
      .withIndex("by_type_updatedAt", (q) => q.eq("type", type))
      .order("desc")
      .take(limit * 2);

    return docs.filter((doc) => doc.deletedAt === undefined).slice(0, limit);
  },
});

export const searchByType = query({
  args: {
    type: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { type, query: searchQuery, limit = 100 }) => {
    const docs = await ctx.db
      .query("contentResources")
      .withSearchIndex("search_text", (s) =>
        s.search("searchText", searchQuery).eq("type", type)
      )
      .take(limit * 2);

    return docs.filter((doc) => doc.deletedAt === undefined).slice(0, limit);
  },
});

export const upsert = mutation({
  args: {
    resourceId: v.string(),
    type: v.string(),
    fields: v.any(),
    searchText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("contentResources")
      .withIndex("by_resourceId", (q) => q.eq("resourceId", args.resourceId))
      .first();

    const doc = {
      resourceId: args.resourceId,
      type: args.type,
      fields: args.fields,
      searchText: args.searchText ?? JSON.stringify(args.fields),
      updatedAt: now,
      deletedAt: undefined,
    };

    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return { action: "updated", resourceId: args.resourceId };
    }

    await ctx.db.insert("contentResources", {
      ...doc,
      createdAt: now,
    });
    return { action: "inserted", resourceId: args.resourceId };
  },
});

export const remove = mutation({
  args: { resourceId: v.string() },
  handler: async (ctx, { resourceId }) => {
    const existing = await ctx.db
      .query("contentResources")
      .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
      .first();

    if (!existing) {
      return { removed: false, resourceId };
    }

    await ctx.db.patch(existing._id, {
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { removed: true, resourceId };
  },
});
