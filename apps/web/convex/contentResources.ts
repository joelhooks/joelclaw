import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

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

export const listLinkedReviewComments = query({
  args: {
    parentResourceId: v.string(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, { parentResourceId, status = "submitted" }) => {
    const links = await ctx.db
      .query("contentResourceResource")
      .withIndex("by_parentId", (q) => q.eq("parentId", parentResourceId))
      .collect();

    const docs = await Promise.all(
      links.map(async (link) => {
        const child = await ctx.db
          .query("contentResources")
          .withIndex("by_resourceId", (q) => q.eq("resourceId", link.childId))
          .first();

        if (!child || child.deletedAt !== undefined) return null;
        if (child.type !== "review_comment") return null;

        const fields =
          child.fields && typeof child.fields === "object" && !Array.isArray(child.fields)
            ? (child.fields as Record<string, unknown>)
            : {};

        const childStatus = typeof fields.status === "string" ? fields.status : undefined;
        if (status && childStatus !== status) return null;

        return {
          resourceId: child.resourceId,
          type: child.type,
          fields: child.fields,
          searchText: child.searchText,
          createdAt: child.createdAt,
          updatedAt: child.updatedAt,
          linkPosition: link.position,
          linkMetadata: link.metadata,
        };
      }),
    );

    return docs
      .filter((doc): doc is NonNullable<typeof doc> => doc !== null)
      .sort((a, b) => {
        const aPos = typeof a.linkPosition === "number" ? a.linkPosition : Number.MAX_SAFE_INTEGER;
        const bPos = typeof b.linkPosition === "number" ? b.linkPosition : Number.MAX_SAFE_INTEGER;
        if (aPos !== bPos) return aPos - bPos;
        return a.createdAt - b.createdAt;
      });
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
