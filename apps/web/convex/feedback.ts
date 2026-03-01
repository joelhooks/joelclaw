import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { internalAction, mutation, query } from "./_generated/server";

const FEEDBACK_EVENT_SOURCE = "feedback-form";

function toReviewEventData(resourceId: string): {
  contentType: string;
  contentSlug: string;
} {
  // resourceId formats accepted:
  // - "type:slug" (canonical, e.g. "post:knowledge-adventure-club-graph")
  // - "type/slug" (legacy)
  const separator = resourceId.includes(":") ? ":" : "/";
  const splitIndex = resourceId.indexOf(separator);
  const rawType = splitIndex > 0 ? resourceId.slice(0, splitIndex).trim() : "post";
  const contentType = rawType === "article" ? "post" : rawType;
  const contentSlug = splitIndex > 0 ? resourceId.slice(splitIndex + 1).trim() : resourceId;

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
      const eventBody = JSON.stringify({
        name: "content/review.submitted",
        data: payload,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Compute HMAC-SHA256 signature if secret is available
      const webhookSecret = process.env.CONVEX_JOELCLAW_WEBHOOK_SECRET?.trim();
      if (webhookSecret) {
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw",
          enc.encode(webhookSecret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const sig = await crypto.subtle.sign("HMAC", key, enc.encode(eventBody));
        headers["x-joelclaw-signature"] = Array.from(new Uint8Array(sig))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }

      const res = await fetch(eventUrl, {
        method: "POST",
        headers,
        body: eventBody,
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

export const listByResourceAndStatus = query({
  args: {
    resourceId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("applied"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, { resourceId, status }) => {
    const docs = await ctx.db
      .query("feedbackItems")
      .withIndex("by_resource_status", (q) => q.eq("resourceId", resourceId).eq("status", status))
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

export const markAppliedByFeedbackIds = mutation({
  args: {
    feedbackIds: v.array(v.string()),
  },
  handler: async (ctx, { feedbackIds }) => {
    const resolvedAt = Date.now();
    let updated = 0;
    for (const id of feedbackIds) {
      const doc = await ctx.db
        .query("feedbackItems")
        .filter((q) => q.eq(q.field("_id"), id))
        .first();
      if (doc && (doc.status === "pending" || doc.status === "processing")) {
        await ctx.db.patch(doc._id, { status: "applied", resolvedAt });
        updated++;
      }
    }
    return { updated, resolvedAt };
  },
});

export const markFailedByFeedbackIds = mutation({
  args: {
    feedbackIds: v.array(v.string()),
  },
  handler: async (ctx, { feedbackIds }) => {
    const resolvedAt = Date.now();
    let updated = 0;
    for (const id of feedbackIds) {
      const doc = await ctx.db
        .query("feedbackItems")
        .filter((q) => q.eq(q.field("_id"), id))
        .first();
      if (doc && (doc.status === "pending" || doc.status === "processing")) {
        await ctx.db.patch(doc._id, { status: "failed", resolvedAt });
        updated++;
      }
    }
    return { updated, resolvedAt };
  },
});
