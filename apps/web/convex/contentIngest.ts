import { v } from "convex/values";
import { mutation } from "./_generated/server";

const adrFieldsValidator = v.object({
  slug: v.string(),
  title: v.string(),
  number: v.string(),
  status: v.string(),
  date: v.string(),
  content: v.string(),
  supersededBy: v.optional(v.string()),
  description: v.optional(v.string()),
});

const postFieldsValidator = v.object({
  slug: v.string(),
  title: v.string(),
  date: v.string(),
  content: v.string(),
  description: v.optional(v.string()),
  image: v.optional(v.string()),
  updated: v.optional(v.string()),
  type: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  source: v.optional(v.string()),
  channel: v.optional(v.string()),
  duration: v.optional(v.string()),
  draft: v.optional(v.boolean()),
});

const discoveryFieldsValidator = v.object({
  title: v.string(),
  slug: v.string(),
  source: v.string(),
  discovered: v.string(),
  tags: v.array(v.string()),
  relevance: v.string(),
  content: v.string(),
});

type ContentType = "adr" | "post" | "discovery";

export const upsertContent = mutation({
  args: {
    resourceId: v.string(),
    type: v.union(v.literal("adr"), v.literal("post"), v.literal("discovery")),
    fields: v.union(adrFieldsValidator, postFieldsValidator, discoveryFieldsValidator),
    searchText: v.string(),
    contentHash: v.optional(v.string()),
  },
  handler: async (ctx, { resourceId, type, fields, searchText, contentHash }) => {
    const normalizedFields = fields as Record<string, unknown>;
    const slug = normalizedFields.slug;
    if (typeof slug !== "string" || slug.trim().length === 0) {
      throw new Error("fields.slug is required");
    }

    // Guard type/fields mismatch at runtime for clearer ingest errors.
    if (type === "adr" && typeof normalizedFields.number !== "string") {
      throw new Error("ADR content requires fields.number");
    }
    if (type === "post" && normalizedFields.number !== undefined) {
      throw new Error("Post content must not include ADR-only fields");
    }
    if (type === "discovery" && normalizedFields.number !== undefined) {
      throw new Error("Discovery content must not include ADR-only fields");
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("contentResources")
      .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
      .first();

    // Hash guard: skip write if content unchanged (saves write units on repeated seeds)
    if (existing && contentHash) {
      const existingHash = (existing as Record<string, unknown>).contentHash;
      if (existingHash === contentHash) {
        return { action: "skipped", resourceId };
      }
    }

    const doc = {
      resourceId,
      type: type as ContentType,
      fields: normalizedFields,
      searchText,
      contentHash,
      updatedAt: now,
      deletedAt: undefined,
    };

    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return { action: "updated", resourceId };
    }

    await ctx.db.insert("contentResources", {
      ...doc,
      createdAt: now,
    });
    return { action: "inserted", resourceId };
  },
});
