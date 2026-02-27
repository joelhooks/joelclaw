import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const createRevision = mutation({
  args: {
    resourceId: v.string(),
    content: v.string(),
    diff: v.optional(v.string()),
    feedbackIds: v.optional(v.array(v.string())),
    agentModel: v.string(),
  },
  handler: async (ctx, { resourceId, content, diff, feedbackIds, agentModel }) => {
    const latestRevision = await ctx.db
      .query("contentRevisions")
      .withIndex("by_resource_revision", (q) => q.eq("resourceId", resourceId))
      .order("desc")
      .first();

    const revisionNumber = latestRevision ? latestRevision.revisionNumber + 1 : 1;
    const createdAt = Date.now();
    const revisionId = await ctx.db.insert("contentRevisions", {
      resourceId,
      revisionNumber,
      content,
      diff,
      feedbackIds: feedbackIds ?? [],
      agentModel,
      createdAt,
    });

    return {
      revisionId,
      resourceId,
      revisionNumber,
      createdAt,
    };
  },
});

export const getRevisions = query({
  args: {
    resourceId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { resourceId, limit = 50 }) => {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    return ctx.db
      .query("contentRevisions")
      .withIndex("by_resource_revision", (q) => q.eq("resourceId", resourceId))
      .order("desc")
      .take(boundedLimit);
  },
});
