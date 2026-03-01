import { ConvexHttpClient } from "convex/browser";
import { anyApi, type FunctionReference } from "convex/server";
import { NonRetriableError } from "inngest";
import { infer } from "../../lib/inference";
import { revalidateContentCache } from "../../lib/revalidate";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";
import { buildGatewaySignalMeta } from "../middleware/gateway-signal";

type ContentType = "adr" | "post" | "discovery" | "video-note";
type SupportedContentType = Exclude<ContentType, "video-note">;
type ReviewCommentStatus = "submitted" | "processing" | "resolved";
type FeedbackStatus = "processing" | "applied" | "failed";

type ContentResourceDoc = {
  resourceId: string;
  type: string;
  fields: unknown;
  searchText?: string;
  createdAt?: number;
  updatedAt?: number;
};

type LinkedReviewComment = {
  resourceId: string;
  type: string;
  fields: unknown;
  searchText?: string;
  createdAt?: number;
  updatedAt?: number;
};

type ReviewComment = {
  resourceId: string;
  paragraphId: string;
  threadId: string;
  content: string;
  fields: Record<string, unknown>;
  searchText?: string;
  createdAt?: number;
  updatedAt?: number;
};

type FeedbackItem = {
  feedbackId: string;
  content: string;
  createdAt?: number;
  status?: string;
};

type ReplacementAssertion = {
  from: string;
  to: string;
  source: string;
};

type FailureEventData = {
  contentSlug: string;
  contentType: ContentType;
  source?: string;
  resourceId?: string;
};

const REVIEW_MODEL = "anthropic/claude-sonnet-4-6";

function parseContentType(value: string): ContentType {
  if (value === "adr" || value === "post" || value === "discovery" || value === "video-note") {
    return value;
  }

  throw new NonRetriableError(
    `Unsupported contentType "${value}". Expected "adr", "post", "discovery", or "video-note".`,
  );
}

function validateSlug(contentSlug: string): void {
  if (!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/u.test(contentSlug)) {
    throw new NonRetriableError(
      `Invalid contentSlug "${contentSlug}". Expected lowercase letters, numbers, slashes, and hyphens.`,
    );
  }
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();

  const strictFenced = trimmed.match(/^```(?:markdown|md|mdx)?\s*\n?([\s\S]*?)\n?```$/iu);
  if (strictFenced?.[1]) {
    return strictFenced[1].trim();
  }

  if (trimmed.startsWith("```")) {
    const lines = trimmed.split(/\r?\n/u);
    const opener = lines[0] ?? "";

    if (/^```(?:markdown|md|mdx)?\s*$/iu.test(opener)) {
      let closingIndex = -1;
      for (let index = lines.length - 1; index > 0; index -= 1) {
        if (/^```\s*$/u.test(lines[index] ?? "")) {
          closingIndex = index;
          break;
        }
      }

      if (closingIndex > 0) {
        return lines.slice(1, closingIndex).join("\n").trim();
      }
    }
  }

  return trimmed;
}

const POST_FRONTMATTER_KEY_PATTERN =
  /^(title|type|date|description|image|tags|updated|draft|source|channel|duration):\s*/iu;

function stripLoosePostFrontmatter(content: string): string {
  const lines = content.split(/\r?\n/u);

  let index = 0;
  while (index < lines.length && lines[index]?.trim().length === 0) {
    index += 1;
  }

  let metadataLineCount = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0) {
      if (metadataLineCount >= 3) {
        return lines.slice(index + 1).join("\n").trimStart();
      }
      return content;
    }

    if (!POST_FRONTMATTER_KEY_PATTERN.test(trimmedLine)) {
      return content;
    }

    metadataLineCount += 1;
  }

  return content;
}

function stripPostFrontmatter(content: string): string {
  const withoutBom = content.replace(/^\uFEFF/u, "");
  const trimmedStart = withoutBom.trimStart();

  if (trimmedStart.startsWith("---")) {
    const match = /^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/u.exec(trimmedStart);
    if (match?.[0]) {
      return trimmedStart.slice(match[0].length).trimStart();
    }

    return content;
  }

  return stripLoosePostFrontmatter(trimmedStart);
}

function normalizeStoredContent(resourceType: string, content: string): string {
  if (resourceType !== "article" && resourceType !== "post") {
    return content;
  }

  return stripPostFrontmatter(content);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function assertNoRewriteMetaCommentary(rewrittenContent: string): void {
  const forbiddenLinePatterns = [
    /^\*\*change applied:\*\*/imu,
    /^change applied:/imu,
    /^applied changes:/imu,
    /^summary of changes:/imu,
  ];

  for (const pattern of forbiddenLinePatterns) {
    if (pattern.test(rewrittenContent)) {
      throw new Error("rewritten content included meta commentary outside the document body");
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getConvexClient(): ConvexHttpClient {
  const convexUrl =
    process.env.CONVEX_URL?.trim() ??
    process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ??
    "";

  if (!convexUrl) {
    throw new NonRetriableError(
      "CONVEX_URL or NEXT_PUBLIC_CONVEX_URL env var is required for content/review.submitted",
    );
  }

  return new ConvexHttpClient(convexUrl);
}

function normalizeContentType(contentType: ContentType): SupportedContentType {
  if (contentType === "video-note") {
    throw new NonRetriableError(
      `contentType "${contentType}" is not yet supported by content-review-apply`,
    );
  }
  return contentType;
}

function toParentResourceId(contentType: SupportedContentType, contentSlug: string): string {
  return `${contentType}:${contentSlug}`;
}

function toContentResourceCandidates(contentType: SupportedContentType, contentSlug: string): string[] {
  if (contentType === "post") {
    return [`article:${contentSlug}`, `post:${contentSlug}`];
  }
  return [`${contentType}:${contentSlug}`];
}

function toCacheTags(contentType: SupportedContentType, contentSlug: string): string[] {
  if (contentType === "post") {
    return [`post:${contentSlug}`, `article:${contentSlug}`, "articles"];
  }
  if (contentType === "adr") {
    return [`adr:${contentSlug}`, "adrs"];
  }
  if (contentType === "discovery") {
    return [`discovery:${contentSlug}`, "discoveries"];
  }
  return [`${contentType}:${contentSlug}`];
}

function toRevalidationPaths(contentType: SupportedContentType, contentSlug: string): string[] {
  if (contentType === "post") {
    return ["/", `/${contentSlug}`, "/feed.xml"];
  }
  if (contentType === "adr") {
    return ["/adrs", `/adrs/${contentSlug}`, "/feed.xml"];
  }
  if (contentType === "discovery") {
    return ["/cool", `/cool/${contentSlug}`, "/feed.xml"];
  }
  return [];
}

async function queryContentResource(resourceId: string): Promise<ContentResourceDoc | null> {
  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).contentResources.getByResourceId as FunctionReference<"query">;
  const result = await client.query(ref, { resourceId });

  if (!result || typeof result !== "object") return null;
  const normalized = result as Partial<ContentResourceDoc>;
  if (!normalized.resourceId || !normalized.type) return null;

  return {
    resourceId: normalized.resourceId,
    type: normalized.type,
    fields: normalized.fields,
    searchText: normalized.searchText,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };
}

async function fetchCurrentContent(
  contentType: SupportedContentType,
  contentSlug: string,
): Promise<{
  resourceId: string;
  type: string;
  fields: Record<string, unknown>;
  content: string;
}> {
  const candidates = toContentResourceCandidates(contentType, contentSlug);

  for (const resourceId of candidates) {
    const doc = await queryContentResource(resourceId);
    if (!doc) continue;

    const fields = ensureRecord(doc.fields);
    const content = asString(fields.content);
    if (!content) continue;
    const normalizedContent =
      contentType === "post" ? normalizeStoredContent(doc.type, content) : content;
    if (!normalizedContent) continue;

    return {
      resourceId: doc.resourceId,
      type: doc.type,
      fields,
      content: normalizedContent,
    };
  }

  throw new NonRetriableError(
    `No content resource found in Convex for ${contentType}/${contentSlug}. Tried ${candidates.join(", ")}.`,
  );
}

function toReviewComment(raw: LinkedReviewComment): ReviewComment | null {
  if (!raw || raw.type !== "review_comment") return null;

  const fields = ensureRecord(raw.fields);
  const content = asString(fields.content);
  if (!content) return null;

  const paragraphId = asString(fields.paragraphId) ?? "unknown";
  const threadId = asString(fields.threadId) ?? `thread:${raw.resourceId}`;

  return {
    resourceId: raw.resourceId,
    paragraphId,
    threadId,
    content,
    fields,
    searchText: asString(raw.searchText),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : undefined,
  };
}

async function listLinkedReviewComments(
  parentResourceId: string,
  status: ReviewCommentStatus,
): Promise<ReviewComment[]> {
  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).contentResources.listLinkedReviewComments as FunctionReference<"query">;
  const result = await client.query(ref, {
    parentResourceId,
    status,
  });

  if (!Array.isArray(result)) return [];

  return result
    .map((entry) => toReviewComment(entry as LinkedReviewComment))
    .filter((entry): entry is ReviewComment => Boolean(entry));
}

function buildCommentSearchText(fields: Record<string, unknown>): string {
  const parts = [
    asString(fields.paragraphId),
    asString(fields.threadId),
    asString(fields.content),
    asString(fields.status),
  ].filter((value): value is string => Boolean(value));

  return parts.join(" ").trim();
}

async function updateReviewCommentStatuses(args: {
  comments: ReviewComment[];
  status: ReviewCommentStatus;
  runId?: string;
  includeResolvedAt?: boolean;
  removeFields?: string[];
}): Promise<number> {
  if (args.comments.length === 0) return 0;

  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).contentResources.upsert as FunctionReference<"mutation">;

  let updated = 0;
  for (const comment of args.comments) {
    const nextFields: Record<string, unknown> = {
      ...comment.fields,
      status: args.status,
      reviewRunId: args.runId,
    };

    if (args.status === "resolved" && args.includeResolvedAt !== false) {
      nextFields.resolvedAt = Date.now();
    }

    for (const fieldName of args.removeFields ?? []) {
      delete nextFields[fieldName];
    }

    await client.mutation(ref, {
      resourceId: comment.resourceId,
      type: "review_comment",
      fields: nextFields,
      searchText: buildCommentSearchText(nextFields),
    });

    updated += 1;
  }

  return updated;
}

function feedbackMutationName(status: FeedbackStatus): "markProcessing" | "markApplied" | "markFailed" {
  if (status === "processing") return "markProcessing";
  if (status === "applied") return "markApplied";
  return "markFailed";
}

async function updateFeedbackStatuses(resourceId: string, status: FeedbackStatus): Promise<number> {
  const client = getConvexClient();
  const mutationName = feedbackMutationName(status);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).feedback[mutationName] as FunctionReference<"mutation">;
  const result = await client.mutation(ref, { resourceId });

  if (!result || typeof result !== "object") return 0;
  const updated = (result as { updated?: unknown }).updated;
  return typeof updated === "number" ? updated : 0;
}

function toFeedbackItem(raw: unknown): FeedbackItem | null {
  const record = ensureRecord(raw);
  const feedbackId = asString(record.feedbackId);
  const content = asString(record.content);
  if (!feedbackId || !content) return null;

  return {
    feedbackId,
    content,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : undefined,
    status: asString(record.status),
  };
}

async function listPendingFeedbackItems(resourceId: string): Promise<FeedbackItem[]> {
  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).feedback.listPendingByResource as FunctionReference<"query">;
  const result = await client.query(ref, { resourceId });

  if (!Array.isArray(result)) return [];

  return result
    .map((entry) => toFeedbackItem(entry))
    .filter((entry): entry is FeedbackItem => Boolean(entry));
}

async function listFeedbackItemsByStatus(
  resourceId: string,
  status: "pending" | "processing" | "applied" | "failed",
): Promise<FeedbackItem[]> {
  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).feedback.listByResourceAndStatus as FunctionReference<"query">;
  const result = await client.query(ref, { resourceId, status });

  if (!Array.isArray(result)) return [];

  return result
    .map((entry) => toFeedbackItem(entry))
    .filter((entry): entry is FeedbackItem => Boolean(entry));
}

function buildReviewPrompt(args: {
  contentType: SupportedContentType;
  contentSlug: string;
  content: string;
  comments: ReviewComment[];
  feedbackItems: FeedbackItem[];
  historicalResolvedComments: ReviewComment[];
  historicalAppliedFeedbackItems: FeedbackItem[];
}): string {
  const commentsText =
    args.comments.length === 0
      ? "None."
      : args.comments
          .map((comment, index) => {
            const timestamp =
              typeof comment.createdAt === "number"
                ? new Date(comment.createdAt).toISOString()
                : "unknown";

            return [
              `Comment ${index + 1}:`,
              `- paragraphId: ${comment.paragraphId}`,
              `- threadId: ${comment.threadId}`,
              `- createdAt: ${timestamp}`,
              `- feedback: ${comment.content}`,
            ].join("\n");
          })
          .join("\n\n");

  const feedbackItemsText =
    args.feedbackItems.length === 0
      ? "None."
      : args.feedbackItems
          .map((item, index) => {
            const timestamp =
              typeof item.createdAt === "number"
                ? new Date(item.createdAt).toISOString()
                : "unknown";
            return [
              `Feedback ${index + 1}:`,
              `- feedbackId: ${item.feedbackId}`,
              `- createdAt: ${timestamp}`,
              `- feedback: ${item.content}`,
            ].join("\n");
          })
          .join("\n\n");

  const historicalResolvedText =
    args.historicalResolvedComments.length === 0
      ? "None."
      : args.historicalResolvedComments
          .slice(-40)
          .map((comment, index) => {
            return [
              `Resolved ${index + 1}:`,
              `- paragraphId: ${comment.paragraphId}`,
              `- threadId: ${comment.threadId}`,
              `- feedback: ${comment.content}`,
            ].join("\n");
          })
          .join("\n\n");

  const historicalAppliedFeedbackText =
    args.historicalAppliedFeedbackItems.length === 0
      ? "None."
      : args.historicalAppliedFeedbackItems
          .slice(-40)
          .map((item, index) => {
            return [
              `Applied ${index + 1}:`,
              `- feedbackId: ${item.feedbackId}`,
              `- feedback: ${item.content}`,
            ].join("\n");
          })
          .join("\n\n");

  return [
    `Resource: ${args.contentType}:${args.contentSlug}`,
    "Apply all submitted review comments and pending feedback items to the content below.",
    "Do not regress previously applied edits unless new feedback explicitly requests reversal.",
    "Return only the full updated markdown/MDX document.",
    "Do not include summaries, notes, or lines like 'Change applied'.",
    "",
    "## Current Content",
    "```md",
    args.content.trimEnd(),
    "```",
    "",
    "## Inline Review Comments (new)",
    commentsText,
    "",
    "## General Feedback Items (new)",
    feedbackItemsText,
    "",
    "## Previously Resolved Review Comments (preserve intent; do not regress)",
    historicalResolvedText,
    "",
    "## Previously Applied Feedback Items (preserve intent; do not regress)",
    historicalAppliedFeedbackText,
  ].join("\n");
}

function systemPromptForContentType(contentType: SupportedContentType): string {
  if (contentType === "adr") {
    return [
      "You edit Architecture Decision Records using submitted review feedback.",
      "Preserve technical intent, structure, and frontmatter.",
      "Only make changes implied by the feedback.",
      "Return the complete updated markdown file only.",
      "No markdown fences and no commentary or change summaries.",
    ].join(" ");
  }

  if (contentType === "post") {
    return [
      "You edit joelclaw articles using submitted review feedback.",
      "Preserve the author's voice and remove filler.",
      "Apply suggested fixes, clarity improvements, and corrections.",
      "Return the complete updated MDX file only.",
      "No markdown fences and no commentary or change summaries.",
    ].join(" ");
  }

  return [
    "You edit discovery notes using submitted review feedback.",
    "Keep the note concise, factual, and actionable.",
    "Return the complete updated markdown file only.",
    "No markdown fences and no commentary or change summaries.",
  ].join(" ");
}

async function rewriteContent(args: {
  contentType: SupportedContentType;
  contentSlug: string;
  currentContent: string;
  comments: ReviewComment[];
  feedbackItems: FeedbackItem[];
  historicalResolvedComments: ReviewComment[];
  historicalAppliedFeedbackItems: FeedbackItem[];
}): Promise<string> {
  const prompt = buildReviewPrompt({
    contentType: args.contentType,
    contentSlug: args.contentSlug,
    content: args.currentContent,
    comments: args.comments,
    feedbackItems: args.feedbackItems,
    historicalResolvedComments: args.historicalResolvedComments,
    historicalAppliedFeedbackItems: args.historicalAppliedFeedbackItems,
  });

  const result = await infer(prompt, {
    task: "rewrite",
    model: REVIEW_MODEL,
    system: systemPromptForContentType(args.contentType),
    component: "content-review",
    action: "content.review.apply",
  });

  const rewritten = stripMarkdownFence(result.text).trim();
  if (!rewritten) {
    throw new Error("content review apply returned empty output");
  }

  return ensureTrailingNewline(rewritten);
}

function validateRewriteLength(currentContent: string, rewrittenContent: string): void {
  const currentLength = currentContent.trim().length;
  const rewrittenLength = rewrittenContent.trim().length;

  if (rewrittenLength === 0) {
    throw new Error("rewritten article content was empty");
  }

  if (currentLength === 0) {
    throw new NonRetriableError("current article content is empty; cannot validate rewrite length");
  }

  const minLength = Math.floor(currentLength * 0.5);
  const maxLength = Math.ceil(currentLength * 1.5);

  if (rewrittenLength < minLength || rewrittenLength > maxLength) {
    throw new Error(
      `rewritten article length ${rewrittenLength} is outside allowed range ${minLength}-${maxLength}`,
    );
  }
}

function normalizeAssertionPhrase(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function extractReplacementAssertionsFromText(source: string): ReplacementAssertion[] {
  const assertions: ReplacementAssertion[] = [];

  const replaceWithPattern =
    /replace\s+["“”']([^"“”']{2,180})["“”']\s+with\s+["“”']([^"“”']{2,180})["“”']/giu;
  const arrowPattern = /["“”']([^"“”']{2,180})["“”']\s*(?:->|→|to)\s*["“”']([^"“”']{2,180})["“”']/giu;

  for (const pattern of [replaceWithPattern, arrowPattern]) {
    let match: RegExpExecArray | null = pattern.exec(source);
    while (match) {
      const from = normalizeAssertionPhrase(match[1] ?? "");
      const to = normalizeAssertionPhrase(match[2] ?? "");
      if (from.length >= 3 && to.length >= 3 && from !== to) {
        assertions.push({ from, to, source });
      }
      match = pattern.exec(source);
    }
  }

  return assertions;
}

function buildHistoricalAssertions(
  resolvedComments: ReviewComment[],
  appliedFeedbackItems: FeedbackItem[],
): ReplacementAssertion[] {
  const candidates = [
    ...resolvedComments.map((comment) => comment.content),
    ...appliedFeedbackItems.map((item) => item.content),
  ];

  const out: ReplacementAssertion[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    for (const assertion of extractReplacementAssertionsFromText(candidate)) {
      const key = `${assertion.from}=>${assertion.to}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(assertion);
    }
  }

  return out;
}

function assertNoHistoricalRegression(args: {
  currentContent: string;
  rewrittenContent: string;
  assertions: ReplacementAssertion[];
}): void {
  if (args.assertions.length === 0) return;

  const current = args.currentContent.toLowerCase();
  const rewritten = args.rewrittenContent.toLowerCase();

  const regressions: string[] = [];

  for (const assertion of args.assertions) {
    const from = assertion.from.toLowerCase();
    const to = assertion.to.toLowerCase();

    const currentHasTo = current.includes(to);
    const rewrittenHasTo = rewritten.includes(to);
    const currentHasFrom = current.includes(from);
    const rewrittenHasFrom = rewritten.includes(from);

    const removedExpected = currentHasTo && !rewrittenHasTo;
    const reintroducedOld = !currentHasFrom && rewrittenHasFrom;

    if (removedExpected || reintroducedOld) {
      regressions.push(`"${assertion.from}" -> "${assertion.to}"`);
    }
  }

  if (regressions.length > 0) {
    throw new Error(
      `rewrite regressed previously applied feedback assertions: ${regressions.slice(0, 6).join(", ")}`,
    );
  }
}

function buildGenericSearchText(fields: Record<string, unknown>): string {
  const values = [
    asString(fields.slug),
    asString(fields.title),
    asString(fields.description),
    asString(fields.status),
    asString(fields.content)?.slice(0, 1000),
  ].filter((entry): entry is string => Boolean(entry));

  if (values.length > 0) return values.join(" ");

  try {
    return JSON.stringify(fields);
  } catch {
    return "";
  }
}

async function writeContentRevision(args: {
  articleResourceId: string;
  contentType: SupportedContentType;
  contentSlug: string;
  previousContent: string;
  updatedContent: string;
  comments: ReviewComment[];
  runId: string;
}): Promise<string> {
  const client = getConvexClient();
  const revisionResourceId = `contentRevision:${args.articleResourceId}:${Date.now()}`;

  const fields: Record<string, unknown> = {
    resourceId: args.articleResourceId,
    contentType: args.contentType,
    contentSlug: args.contentSlug,
    previousContent: args.previousContent,
    updatedContent: args.updatedContent,
    commentIds: args.comments.map((comment) => comment.resourceId),
    commentCount: args.comments.length,
    runId: args.runId,
    model: REVIEW_MODEL,
    createdAt: Date.now(),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).contentResources.upsert as FunctionReference<"mutation">;
  await client.mutation(ref, {
    resourceId: revisionResourceId,
    type: "content_revision",
    fields,
    searchText: buildGenericSearchText(fields),
  });

  return revisionResourceId;
}

async function updateArticleContent(args: {
  resourceId: string;
  type: string;
  existingFields: Record<string, unknown>;
  updatedContent: string;
}): Promise<void> {
  const client = getConvexClient();
  const normalizedContent = normalizeStoredContent(args.type, args.updatedContent);
  const nextFields: Record<string, unknown> = {
    ...args.existingFields,
    content: normalizedContent,
  };

  if (typeof nextFields.updated === "string") {
    nextFields.updated = new Date().toISOString();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).contentResources.upsert as FunctionReference<"mutation">;
  await client.mutation(ref, {
    resourceId: args.resourceId,
    type: args.type,
    fields: nextFields,
    searchText: buildGenericSearchText(nextFields),
  });
}
function parseFailureInput(data: unknown): FailureEventData | null {
  const record = ensureRecord(data);

  const directSlug = asString(record.contentSlug);
  const directType = asString(record.contentType);
  if (directSlug && directType) {
    try {
      return {
        contentSlug: directSlug,
        contentType: parseContentType(directType),
        source: asString(record.source),
        resourceId: asString(record.resourceId),
      };
    } catch {
      return null;
    }
  }

  const nestedEvent = ensureRecord(record.event);
  if (Object.keys(nestedEvent).length > 0) {
    return parseFailureInput(nestedEvent.data);
  }

  return null;
}

async function rollbackCommentStatusesOnFailure(args: {
  parentResourceId: string;
  runId?: string;
}): Promise<number> {
  const processing = await listLinkedReviewComments(args.parentResourceId, "processing");
  const resolved = args.runId
    ? await listLinkedReviewComments(args.parentResourceId, "resolved")
    : [];

  const resetCandidates = [...processing, ...resolved].filter((comment) => {
    if (!args.runId) return true;
    const reviewRunId = asString(comment.fields.reviewRunId);
    return !reviewRunId || reviewRunId === args.runId;
  });

  if (resetCandidates.length === 0) return 0;

  return updateReviewCommentStatuses({
    comments: resetCandidates,
    status: "submitted",
    removeFields: ["resolvedAt", "reviewRunId"],
  });
}

export const contentReviewApply = inngest.createFunction(
  {
    id: "content-review-apply",
    name: "Content Review Apply",
    retries: 2,
    concurrency: {
      limit: 1,
      key:
        'event.data.resourceId ? event.data.resourceId : (event.data.contentType == "post" ? "post:" + event.data.contentSlug : event.data.contentType + ":" + event.data.contentSlug)',
    },
    onFailure: async ({ error, event, step, runId, ...rest }) => {
      const failureInput = parseFailureInput(event.data);
      if (!failureInput) return;

      const contentType = normalizeContentType(failureInput.contentType);
      const parentResourceId = toParentResourceId(contentType, failureInput.contentSlug);
      const feedbackResourceId = failureInput.resourceId ?? parentResourceId;

      const revertedCount = await step.run("rollback-comments-to-submitted", async () => {
        return rollbackCommentStatusesOnFailure({
          parentResourceId,
          runId,
        });
      });

      const failedFeedbackCount = await step.run("mark-feedback-failed", async () => {
        return updateFeedbackStatuses(feedbackResourceId, "failed");
      });

      const gateway = (rest as { gateway?: GatewayContext }).gateway;
      const message = formatError(error);

      await step.run("notify-gateway-failure", async () => {
        if (!gateway) return { notified: false, reason: "gateway-unavailable" };

        await gateway.alert(
          `Content review apply failed for ${contentType}/${failureInput.contentSlug}: ${message}`,
          {
            ...buildGatewaySignalMeta("content.review", "error"),
            contentType,
            contentSlug: failureInput.contentSlug,
            parentResourceId,
            feedbackResourceId,
            revertedCount,
            failedFeedbackCount,
            source: failureInput.source,
          },
        );

        return { notified: true };
      });
    },
  },
  { event: "content/review.submitted" },
  async ({ event, step, runId, gateway }) => {
    const contentSlug = event.data.contentSlug.trim();
    const contentType = normalizeContentType(parseContentType(event.data.contentType.trim()));

    validateSlug(contentSlug);

    const parentResourceId = toParentResourceId(contentType, contentSlug);
    const feedbackResourceId = asString(event.data.resourceId) ?? parentResourceId;
    const cacheTags = toCacheTags(contentType, contentSlug);
    const cachePaths = toRevalidationPaths(contentType, contentSlug);
    const primaryCacheTag = cacheTags[0] ?? `${contentType}:${contentSlug}`;

    const article = await step.run("fetch-article", async () => {
      return fetchCurrentContent(contentType, contentSlug);
    });

    const {
      submittedComments,
      pendingFeedbackItems,
      historicalResolvedComments,
      historicalAppliedFeedbackItems,
    } = await step.run("fetch-review-feedback-state", async () => {
      const [comments, feedbackItems, resolvedComments, appliedFeedbackItems] = await Promise.all([
        listLinkedReviewComments(parentResourceId, "submitted"),
        listPendingFeedbackItems(feedbackResourceId),
        listLinkedReviewComments(parentResourceId, "resolved"),
        listFeedbackItemsByStatus(feedbackResourceId, "applied"),
      ]);

      return {
        submittedComments: comments,
        pendingFeedbackItems: feedbackItems,
        historicalResolvedComments: resolvedComments,
        historicalAppliedFeedbackItems: appliedFeedbackItems,
      };
    });

    if (submittedComments.length === 0 && pendingFeedbackItems.length === 0) {
      return {
        status: "noop",
        reason: "no-submitted-review-feedback",
        contentType,
        contentSlug,
        resourceId: article.resourceId,
      };
    }

    const historicalAssertions = await step.run("build-historical-assertions", async () => {
      return buildHistoricalAssertions(historicalResolvedComments, historicalAppliedFeedbackItems);
    });

    const feedbackProcessingCount = await step.run("mark-feedback-processing", async () => {
      return updateFeedbackStatuses(feedbackResourceId, "processing");
    });

    await step.run("mark-comments-processing", async () => {
      return updateReviewCommentStatuses({
        comments: submittedComments,
        status: "processing",
        runId,
      });
    });

    const rewrittenContent = await step.run("agent-edit", async () => {
      return rewriteContent({
        contentType,
        contentSlug,
        currentContent: article.content,
        comments: submittedComments,
        feedbackItems: pendingFeedbackItems,
        historicalResolvedComments,
        historicalAppliedFeedbackItems,
      });
    });
    const normalizedRewrittenContent = await step.run("normalize-edited-content", async () => {
      return normalizeStoredContent(article.type, rewrittenContent);
    });

    await step.run("validate-edited-content", async () => {
      assertNoRewriteMetaCommentary(normalizedRewrittenContent);
      validateRewriteLength(article.content, normalizedRewrittenContent);
      assertNoHistoricalRegression({
        currentContent: article.content,
        rewrittenContent: normalizedRewrittenContent,
        assertions: historicalAssertions,
      });
      return {
        currentLength: article.content.trim().length,
        rewrittenLength: normalizedRewrittenContent.trim().length,
        historicalAssertionCount: historicalAssertions.length,
      };
    });

    const revisionResourceId = await step.run("write-content-revision", async () => {
      return writeContentRevision({
        articleResourceId: article.resourceId,
        contentType,
        contentSlug,
        previousContent: article.content,
        updatedContent: normalizedRewrittenContent,
        comments: submittedComments,
        runId,
      });
    });

    await step.run("update-article-content", async () => {
      await updateArticleContent({
        resourceId: article.resourceId,
        type: article.type,
        existingFields: article.fields,
        updatedContent: normalizedRewrittenContent,
      });
    });

    const resolvedCount = await step.run("mark-comments-resolved", async () => {
      return updateReviewCommentStatuses({
        comments: submittedComments,
        status: "resolved",
        runId,
      });
    });

    const feedbackAppliedCount = await step.run("mark-feedback-applied", async () => {
      return updateFeedbackStatuses(feedbackResourceId, "applied");
    });

    await step.run("revalidate-cache", async () => {
      await revalidateContentCache({
        tags: cacheTags,
        paths: cachePaths,
      });
    });

    await step.run("notify-gateway-success", async () => {
      if (!gateway) return { notified: false, reason: "gateway-unavailable" };

      await gateway.notify("content.review.applied", {
        ...buildGatewaySignalMeta("content.review", "info"),
        resourceId: article.resourceId,
        parentResourceId,
        feedbackResourceId,
        revisionResourceId,
        cacheTag: primaryCacheTag,
        cacheTags,
        cachePaths,
        contentType,
        contentSlug,
        commentsResolved: resolvedCount,
        feedbackResolved: feedbackAppliedCount,
        historicalAssertionCount: historicalAssertions.length,
      });

      return { notified: true };
    });

    return {
      status: "completed",
      contentType,
      contentSlug,
      resourceId: article.resourceId,
      parentResourceId,
      feedbackResourceId,
      revisionResourceId,
      resolvedCount,
      feedbackProcessingCount,
      feedbackAppliedCount,
      historicalAssertionCount: historicalAssertions.length,
      cacheTag: primaryCacheTag,
      cacheTags,
      cachePaths,
    };
  },
);
