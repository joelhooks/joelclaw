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
});

type ContentType = "adr" | "post";

export const upsertContent = mutation({
  args: {
    resourceId: v.string(),
    type: v.union(v.literal("adr"), v.literal("post")),
    fields: v.union(adrFieldsValidator, postFieldsValidator),
    searchText: v.string(),
  },
  handler: async (ctx, { resourceId, type, fields, searchText }) => {
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

    const now = Date.now();
    const existing = await ctx.db
      .query("contentResources")
      .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
      .first();

    const doc = {
      resourceId,
      type: type as ContentType,
      fields: normalizedFields,
      searchText,
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
