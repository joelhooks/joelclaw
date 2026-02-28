import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { internalAction, mutation, query } from "./_generated/server";

const FEEDBACK_EVENT_SOURCE = "feedback-form";

function toReviewEventData(resourceId: string): {
  contentType: string;
  contentSlug: string;
} {
  const [typePart, ...slugParts] = resourceId.split(":");
  const rawType = typePart?.trim() || "post";
  const contentType = rawType === "article" ? "post" : rawType;
  const contentSlug = slugParts.join(":").trim() || resourceId;

  return {
    contentType,
    contentSlug,
  };
}

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

    const { contentType, contentSlug } = toReviewEventData(resourceId);

    // Fire-and-forget: never block feedback writes on event delivery.
    try {
      await ctx.scheduler.runAfter(0, internal.feedback.feedbackSubmitted, {
        resourceId,
        contentType,
        contentSlug,
        source: FEEDBACK_EVENT_SOURCE,
      });
    } catch (error) {
      console.error("[feedback] Failed to schedule feedbackSubmitted action", {
        resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      feedbackId,
      resourceId,
      status: "pending" as const,
      createdAt,
    };
  },
});

export const feedbackSubmitted = internalAction({
  args: {
    resourceId: v.string(),
    contentType: v.string(),
    contentSlug: v.string(),
    source: v.literal(FEEDBACK_EVENT_SOURCE),
  },
  handler: async (_ctx, payload) => {
    const eventUrl = process.env.CONVEX_INNGEST_EVENT_URL?.trim();
    if (!eventUrl) {
      console.warn("[feedback] CONVEX_INNGEST_EVENT_URL not set, skipping event", {
        resourceId: payload.resourceId,
      });
      return;
    }

    try {
      const res = await fetch(eventUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "content/review.submitted",
          data: payload,
        }),
      });

      if (!res.ok) {
        console.error("[feedback] content/review.submitted send failed", {
          resourceId: payload.resourceId,
          detail: await res.text(),
        });
      }
    } catch (error) {
      console.error("[feedback] Inngest endpoint unreachable", {
        resourceId: payload.resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

export const listPendingByResource = query({
  args: {
    resourceId: v.string(),
  },
  handler: async (ctx, { resourceId }) => {
    const docs = await ctx.db
      .query("feedbackItems")
      .withIndex("by_resource_status", (q) =>
        q.eq("resourceId", resourceId).eq("status", "pending"),
      )
      .collect();

    return docs
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((doc) => ({
        feedbackId: doc._id,
        content: doc.content,
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
