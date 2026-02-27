/**
 * Review comment operations using contentResources + contentResourceResource.
 *
 * Comments are contentResources with type "review_comment".
 * Linked to parent content via contentResourceResource.
 *
 * Parent resourceId patterns:
 *   adr:0106-adr-review-pipeline
 *   post:my-blog-post
 *   discovery:cool-thing
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ── Queries ──────────────────────────────────────────────────────────

/** Get all review comments for a content resource */
export const getByContent = query({
  args: {
    contentId: v.string(), // resourceId of parent, e.g. "adr:0106-slug"
  },
  handler: async (ctx, { contentId }) => {
    const links = await ctx.db
      .query("contentResourceResource")
      .withIndex("by_parentId", (q) => q.eq("parentId", contentId))
      .collect();

    const comments = await Promise.all(
      links.map(async (link) => {
        const child = await ctx.db
          .query("contentResources")
          .withIndex("by_resourceId", (q) => q.eq("resourceId", link.childId))
          .first();
        if (!child || child.deletedAt !== undefined) return null;
        if (child.type !== "review_comment") return null;

        const fields = (child.fields ?? {}) as Record<string, unknown>;
        return {
          _id: child._id,
          resourceId: child.resourceId,
          paragraphId: (fields.paragraphId as string) ?? "",
          content: (fields.content as string) ?? "",
          status: (fields.status as string) ?? "draft",
          threadId: (fields.threadId as string) ?? "",
          parentCommentId: (fields.parentCommentId as string) ?? undefined,
          createdAt: child.createdAt,
          updatedAt: child.updatedAt,
          position: link.position,
        };
      }),
    );

    return comments
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

/** Count draft comments for a content resource */
export const draftCount = query({
  args: { contentId: v.string() },
  handler: async (ctx, { contentId }) => {
    const links = await ctx.db
      .query("contentResourceResource")
      .withIndex("by_parentId", (q) => q.eq("parentId", contentId))
      .collect();

    let count = 0;
    for (const link of links) {
      const child = await ctx.db
        .query("contentResources")
        .withIndex("by_resourceId", (q) => q.eq("resourceId", link.childId))
        .first();
      if (!child || child.deletedAt !== undefined) continue;
      if (child.type !== "review_comment") continue;
      const fields = (child.fields ?? {}) as Record<string, unknown>;
      if (fields.status === "draft") count++;
    }
    return count;
  },
});

// ── Mutations ────────────────────────────────────────────────────────

/** Add a new review comment */
export const addComment = mutation({
  args: {
    contentId: v.string(), // parent resourceId
    paragraphId: v.string(),
    content: v.string(),
    threadId: v.optional(v.string()),
  },
  handler: async (ctx, { contentId, paragraphId, content, threadId }) => {
    const now = Date.now();
    const commentResourceId = `review:${contentId}:${paragraphId}:${now}`;
    const actualThreadId = threadId ?? `thread:${contentId}:${paragraphId}`;

    // Create the comment as a contentResource
    const commentId = await ctx.db.insert("contentResources", {
      resourceId: commentResourceId,
      type: "review_comment",
      fields: {
        paragraphId,
        content,
        status: "draft",
        threadId: actualThreadId,
      },
      searchText: `${paragraphId} ${content}`,
      createdAt: now,
      updatedAt: now,
    });

    // Link to parent content
    await ctx.db.insert("contentResourceResource", {
      parentId: contentId,
      childId: commentResourceId,
    });

    return { commentId, resourceId: commentResourceId };
  },
});

/** Update a comment's content */
export const updateComment = mutation({
  args: {
    resourceId: v.string(),
    content: v.string(),
  },
  handler: async (ctx, { resourceId, content }) => {
    const doc = await ctx.db
      .query("contentResources")
      .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
      .first();
    if (!doc) return { updated: false };

    const fields = (doc.fields ?? {}) as Record<string, unknown>;
    await ctx.db.patch(doc._id, {
      fields: { ...fields, content },
      searchText: `${fields.paragraphId ?? ""} ${content}`,
      updatedAt: Date.now(),
    });
    return { updated: true };
  },
});

/** Delete a comment (soft-delete) */
export const deleteComment = mutation({
  args: { resourceId: v.string() },
  handler: async (ctx, { resourceId }) => {
    const doc = await ctx.db
      .query("contentResources")
      .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
      .first();
    if (!doc) return { deleted: false };

    await ctx.db.patch(doc._id, {
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { deleted: true };
  },
});

/** Submit all draft comments for a content resource (batch → "submitted") */
export const submitReview = mutation({
  args: { contentId: v.string() },
  handler: async (ctx, { contentId }) => {
    const links = await ctx.db
      .query("contentResourceResource")
      .withIndex("by_parentId", (q) => q.eq("parentId", contentId))
      .collect();

    let submitted = 0;
    for (const link of links) {
      const child = await ctx.db
        .query("contentResources")
        .withIndex("by_resourceId", (q) => q.eq("resourceId", link.childId))
        .first();
      if (!child || child.deletedAt !== undefined) continue;
      if (child.type !== "review_comment") continue;

      const fields = (child.fields ?? {}) as Record<string, unknown>;
      if (fields.status !== "draft") continue;

      await ctx.db.patch(child._id, {
        fields: { ...fields, status: "submitted" },
        updatedAt: Date.now(),
      });
      submitted++;
    }
    return { submitted };
  },
});

/** Resolve all submitted comments for a content resource */
export const resolveComments = mutation({
  args: { contentId: v.string() },
  handler: async (ctx, { contentId }) => {
    const links = await ctx.db
      .query("contentResourceResource")
      .withIndex("by_parentId", (q) => q.eq("parentId", contentId))
      .collect();

    let resolved = 0;
    for (const link of links) {
      const child = await ctx.db
        .query("contentResources")
        .withIndex("by_resourceId", (q) => q.eq("resourceId", link.childId))
        .first();
      if (!child || child.deletedAt !== undefined) continue;
      if (child.type !== "review_comment") continue;

      const fields = (child.fields ?? {}) as Record<string, unknown>;
      if (fields.status !== "submitted") continue;

      await ctx.db.patch(child._id, {
        fields: { ...fields, status: "resolved" },
        updatedAt: Date.now(),
      });
      resolved++;
    }
    return { resolved };
  },
});
