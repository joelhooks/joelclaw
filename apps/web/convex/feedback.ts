import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";

async function patchByStatus(
  ctx: MutationCtx,
  resourceId: string,
  fromStatuses: Array<"pending" | "processing">,
  status: "processing" | "applied" | "failed",
  resolvedAt?: number,
) {
  let updated = 0;

  for (const fromStatus of fromStatuses) {
    const docs = await ctx.db
      .query("feedbackItems")
      .withIndex("by_resource_status", (q) =>
        q.eq("resourceId", resourceId).eq("status", fromStatus),
      )
      .collect();

    for (const doc of docs) {
      await ctx.db.patch(doc._id, {
        status,
        resolvedAt,
      });
      updated += 1;
    }
  }

  return updated;
}

export const create = mutation({
  args: {
    resourceId: v.string(),
    content: v.string(),
    authorId: v.optional(v.string()),
  },
  handler: async (ctx, { resourceId, content, authorId }) => {
    const createdAt = Date.now();
    const feedbackId = await ctx.db.insert("feedbackItems", {
      resourceId,
      content,
      status: "pending",
      authorId,
      createdAt,
      resolvedAt: undefined,
    });

    return {
      feedbackId,
      resourceId,
      status: "pending" as const,
      createdAt,
    };
  },
});

export const listByResource = query({
  args: {
    resourceId: v.string(),
  },
  handler: async (ctx, { resourceId }) => {
    const docs = await ctx.db
      .query("feedbackItems")
      .withIndex("by_resource", (q) => q.eq("resourceId", resourceId))
      .collect();

    return docs
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((doc) => ({
        feedbackId: doc._id,
        status: doc.status,
        createdAt: doc.createdAt,
        resolvedAt: doc.resolvedAt,
      }));
  },
});

export const markProcessing = mutation({
  args: {
    resourceId: v.string(),
  },
  handler: async (ctx, { resourceId }) => {
    const updated = await patchByStatus(ctx, resourceId, ["pending"], "processing");
    return { resourceId, updated };
  },
});

export const markApplied = mutation({
  args: {
    resourceId: v.string(),
  },
  handler: async (ctx, { resourceId }) => {
    const resolvedAt = Date.now();
    const updated = await patchByStatus(
      ctx,
      resourceId,
      ["pending", "processing"],
      "applied",
      resolvedAt,
    );
    return { resourceId, updated, resolvedAt };
  },
});

export const markFailed = mutation({
  args: {
    resourceId: v.string(),
  },
  handler: async (ctx, { resourceId }) => {
    const resolvedAt = Date.now();
    const updated = await patchByStatus(
      ctx,
      resourceId,
      ["pending", "processing"],
      "failed",
      resolvedAt,
    );
    return { resourceId, updated, resolvedAt };
  },
});
