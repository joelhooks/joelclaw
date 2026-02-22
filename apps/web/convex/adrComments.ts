/**
 * ADR Review Comments — Convex functions (ADR-0106)
 *
 * CRUD for paragraph-level inline comments on ADRs.
 * All mutations require authenticated owner (Joel).
 */
import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { authComponent } from "./auth";

// ── Queries ────────────────────────────────────────────────────

/** Get all comments for an ADR, grouped by paragraph */
export const getByAdr = query({
  args: { adrSlug: v.string() },
  handler: async (ctx, { adrSlug }) => {
    return ctx.db
      .query("adrComments")
      .withIndex("by_adr", (q) => q.eq("adrSlug", adrSlug))
      .collect();
  },
});

/** Get draft count for an ADR (for the FAB badge) */
export const draftCount = query({
  args: { adrSlug: v.string() },
  handler: async (ctx, { adrSlug }) => {
    const drafts = await ctx.db
      .query("adrComments")
      .withIndex("by_adr_status", (q) =>
        q.eq("adrSlug", adrSlug).eq("status", "draft"),
      )
      .collect();
    return drafts.length;
  },
});

// ── Mutations ──────────────────────────────────────────────────

/** Add a new comment to a paragraph */
export const addComment = mutation({
  args: {
    adrSlug: v.string(),
    paragraphId: v.string(),
    content: v.string(),
    threadId: v.optional(v.string()),
    parentId: v.optional(v.id("adrComments")),
  },
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) throw new Error("Not authenticated");

    const now = Date.now();
    const threadId = args.threadId ?? `thread-${args.paragraphId}-${now}`;

    return ctx.db.insert("adrComments", {
      adrSlug: args.adrSlug,
      paragraphId: args.paragraphId,
      content: args.content,
      threadId,
      parentId: args.parentId,
      status: "draft",
      authorId: user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Update a draft comment's content */
export const updateComment = mutation({
  args: {
    id: v.id("adrComments"),
    content: v.string(),
  },
  handler: async (ctx, { id, content }) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) throw new Error("Not authenticated");

    const comment = await ctx.db.get(id);
    if (!comment) throw new Error("Comment not found");
    if (comment.status !== "draft") throw new Error("Can only edit drafts");

    await ctx.db.patch(id, { content, updatedAt: Date.now() });
  },
});

/** Delete a draft comment */
export const deleteComment = mutation({
  args: { id: v.id("adrComments") },
  handler: async (ctx, { id }) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) throw new Error("Not authenticated");

    const comment = await ctx.db.get(id);
    if (!comment) throw new Error("Comment not found");
    if (comment.status !== "draft") throw new Error("Can only delete drafts");

    await ctx.db.delete(id);
  },
});

/** Mark all drafts for an ADR as submitted */
export const submitReview = mutation({
  args: { adrSlug: v.string() },
  handler: async (ctx, { adrSlug }) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) throw new Error("Not authenticated");

    const drafts = await ctx.db
      .query("adrComments")
      .withIndex("by_adr_status", (q) =>
        q.eq("adrSlug", adrSlug).eq("status", "draft"),
      )
      .collect();

    if (drafts.length === 0) throw new Error("No draft comments to submit");

    const now = Date.now();
    await Promise.all(
      drafts.map((d) =>
        ctx.db.patch(d._id, { status: "submitted" as const, updatedAt: now }),
      ),
    );

    return { submitted: drafts.length };
  },
});

/** Mark submitted comments as resolved (called by agent after applying) */
export const resolveComments = mutation({
  args: { adrSlug: v.string() },
  handler: async (ctx, { adrSlug }) => {
    const submitted = await ctx.db
      .query("adrComments")
      .withIndex("by_adr_status", (q) =>
        q.eq("adrSlug", adrSlug).eq("status", "submitted"),
      )
      .collect();

    const now = Date.now();
    await Promise.all(
      submitted.map((s) =>
        ctx.db.patch(s._id, { status: "resolved" as const, updatedAt: now }),
      ),
    );

    return { resolved: submitted.length };
  },
});
