/**
 * Vault notes — Convex queries and mutations.
 * Owner-only access. Data synced from disk via Inngest.
 */
import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

/** List all notes grouped by section (no content — lightweight) */
export const listBySection = query({
  args: {},
  handler: async (ctx) => {
    const notes = await ctx.db
      .query("vaultNotes")
      .withIndex("by_section")
      .collect();

    const tree: Record<
      string,
      { path: string; title: string; type: string; tags: string[] }[]
    > = {};

    for (const note of notes) {
      if (!tree[note.section]) tree[note.section] = [];
      const sectionNotes = tree[note.section];
      if (!sectionNotes) continue;
      sectionNotes.push({
        path: note.path,
        title: note.title,
        type: note.type,
        tags: note.tags,
      });
    }

    return { tree, total: notes.length };
  },
});

/** Get a single note by path (with content) */
export const getByPath = query({
  args: { path: v.string() },
  handler: async (ctx, { path }) => {
    return ctx.db
      .query("vaultNotes")
      .withIndex("by_path", (q) => q.eq("path", path))
      .first();
  },
});

/** Search notes by title (simple prefix/contains match) */
export const search = query({
  args: { query: v.string() },
  handler: async (ctx, { query: q }) => {
    // Convex full-text search
    const results = await ctx.db
      .query("vaultNotes")
      .withSearchIndex("search_title_content", (s) => s.search("title", q))
      .take(30);

    return results.map((n) => ({
      path: n.path,
      title: n.title,
      type: n.type,
      tags: n.tags,
      section: n.section,
    }));
  },
});

/** Upsert a vault note — called by the sync worker via ConvexHttpClient */
export const upsert = mutation({
  args: {
    path: v.string(),
    title: v.string(),
    content: v.string(),
    html: v.optional(v.string()),
    type: v.string(),
    tags: v.array(v.string()),
    section: v.string(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vaultNotes")
      .withIndex("by_path", (q) => q.eq("path", args.path))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        syncedAt: Date.now(),
      });
      return { action: "updated", path: args.path };
    }

    await ctx.db.insert("vaultNotes", {
      ...args,
      syncedAt: Date.now(),
    });
    return { action: "inserted", path: args.path };
  },
});

/** Remove notes that no longer exist on disk */
export const removeByPaths = mutation({
  args: { paths: v.array(v.string()) },
  handler: async (ctx, { paths }) => {
    for (const path of paths) {
      const note = await ctx.db
        .query("vaultNotes")
        .withIndex("by_path", (q) => q.eq("path", path))
        .first();
      if (note) await ctx.db.delete(note._id);
    }
    return { removed: paths.length };
  },
});
