import { ConvexHttpClient } from "convex/browser";
import { anyApi, type FunctionReference } from "convex/server";
import { NonRetriableError } from "inngest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { rehypeParagraphIds } from "@joelclaw/mdx-pipeline";
import { parsePiJsonAssistant } from "../../lib/langfuse";
import { inngest } from "../client";

const HOME_DIR = process.env.HOME ?? "/Users/joel";
const VAULT_ROOT = join(HOME_DIR, "Vault");
const REPO_ROOT = join(HOME_DIR, "Code", "joelhooks", "joelclaw");
const COMMENTABLE_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote"]);

type ContentType = "adr" | "post" | "discovery" | "video-note";
type SupportedContentType = Exclude<ContentType, "video-note">;

type ContentTarget = {
  contentSlug: string;
  contentType: SupportedContentType;
  parentResourceId: string;
  absolutePath: string;
  gitRoot: string;
  gitPath: string;
  url: string;
  systemPrompt: string;
};

type LinkedReviewComment = {
  resourceId: string;
  type: string;
  fields: unknown;
  searchText?: string;
  createdAt?: number;
  updatedAt?: number;
  linkPosition?: number;
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
  linkPosition?: number;
};

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
};

function readShellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value == null) return "";
  return String(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function extractText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text" || node.type === "raw") {
    return typeof node.value === "string" ? node.value : "";
  }
  if (!Array.isArray(node.children)) return "";
  return node.children.map((child) => extractText(child)).join("");
}

function collectParagraphContexts(node: HastNode | undefined, byId: Map<string, string>): void {
  if (!node) return;

  if (node.type === "element" && typeof node.tagName === "string" && COMMENTABLE_TAGS.has(node.tagName)) {
    const id = node.properties?.id;
    if (typeof id === "string" && id.trim().length > 0) {
      const text = normalizeWhitespace(extractText(node));
      if (text.length > 0 && !byId.has(id)) {
        byId.set(id, text);
      }
    }
  }

  if (!Array.isArray(node.children)) return;
  for (const child of node.children) {
    collectParagraphContexts(child, byId);
  }
}

async function buildParagraphContextMap(markdown: string): Promise<Record<string, string>> {
  try {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeParagraphIds);

    const parsed = processor.parse(markdown);
    const tree = (await processor.run(parsed as never)) as HastNode;
    const byId = new Map<string, string>();
    collectParagraphContexts(tree, byId);
    return Object.fromEntries(byId);
  } catch {
    return {};
  }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md|mdx)?\s*([\s\S]*?)\s*```$/iu);
  return fenced?.[1] ?? trimmed;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateSlug(contentSlug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(contentSlug)) {
    throw new NonRetriableError(
      `Invalid contentSlug "${contentSlug}". Expected lowercase letters, numbers, and hyphens.`,
    );
  }
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function parseContentType(value: string): ContentType {
  if (value === "adr" || value === "post" || value === "discovery" || value === "video-note") {
    return value;
  }
  throw new NonRetriableError(
    `Unsupported contentType "${value}". Expected "adr", "post", "discovery", or "video-note".`,
  );
}

function resolveContentTarget(contentType: ContentType, contentSlug: string): ContentTarget {
  switch (contentType) {
    case "adr":
      return {
        contentSlug,
        contentType,
        parentResourceId: `adr:${contentSlug}`,
        absolutePath: join(VAULT_ROOT, "docs", "decisions", `${contentSlug}.md`),
        gitRoot: VAULT_ROOT,
        gitPath: join("docs", "decisions", `${contentSlug}.md`),
        url: `https://joelclaw.com/adrs/${contentSlug}`,
        systemPrompt: [
          "You update ADR markdown files based on submitted review comments.",
          "Preserve frontmatter and technical consistency.",
          "Keep decision logic coherent; only change what comments request.",
          "Return only the complete updated markdown file.",
        ].join(" "),
      };
    case "post":
      return {
        contentSlug,
        contentType,
        parentResourceId: `post:${contentSlug}`,
        absolutePath: join(REPO_ROOT, "apps", "web", "content", `${contentSlug}.mdx`),
        gitRoot: REPO_ROOT,
        gitPath: join("apps", "web", "content", `${contentSlug}.mdx`),
        url: `https://joelclaw.com/${contentSlug}`,
        systemPrompt: [
          "You update joelclaw.com blog post MDX based on submitted review comments.",
          "Keep Joel's direct first-person voice and preserve frontmatter.",
          "Maintain existing section structure unless comments explicitly request changes.",
          "Return only the complete updated MDX file.",
        ].join(" "),
      };
    case "discovery":
      return {
        contentSlug,
        contentType,
        parentResourceId: `discovery:${contentSlug}`,
        absolutePath: join(REPO_ROOT, "apps", "web", "content", "discoveries", `${contentSlug}.mdx`),
        gitRoot: REPO_ROOT,
        gitPath: join("apps", "web", "content", "discoveries", `${contentSlug}.mdx`),
        url: `https://joelclaw.com/cool/${contentSlug}`,
        systemPrompt: [
          "You update joelclaw.com discovery MDX notes based on submitted review comments.",
          "Keep concise, clear discovery-note tone and preserve frontmatter/links.",
          "Apply comments directly while retaining factual accuracy.",
          "Return only the complete updated MDX file.",
        ].join(" "),
      };
    case "video-note":
      throw new NonRetriableError(
        `contentType "${contentType}" is not yet mapped to a file path for contentSlug "${contentSlug}".`,
      );
  }
}

function getConvexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!url) {
    throw new NonRetriableError(
      "NEXT_PUBLIC_CONVEX_URL env var is required for content/review.submitted",
    );
  }
  return new ConvexHttpClient(url);
}

async function querySubmittedReviewComments(parentResourceId: string): Promise<ReviewComment[]> {
  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).contentResources.listLinkedReviewComments as FunctionReference<"query">;
  const result = await client.query(ref, {
    parentResourceId,
    status: "submitted",
  });

  if (!Array.isArray(result)) return [];

  const normalized: ReviewComment[] = [];
  for (const raw of result as LinkedReviewComment[]) {
    if (!raw || typeof raw.resourceId !== "string") continue;
    if (raw.type !== "review_comment") continue;

    const fields = ensureRecord(raw.fields);
    const status = typeof fields.status === "string" ? fields.status : undefined;
    if (status !== "submitted") continue;

    const content = typeof fields.content === "string" ? fields.content.trim() : "";
    if (!content) continue;

    const paragraphId = typeof fields.paragraphId === "string" ? fields.paragraphId : "unknown";
    const threadId = typeof fields.threadId === "string" ? fields.threadId : `thread:${raw.resourceId}`;

    normalized.push({
      resourceId: raw.resourceId,
      paragraphId,
      threadId,
      content,
      fields,
      searchText: typeof raw.searchText === "string" ? raw.searchText : undefined,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : undefined,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : undefined,
      linkPosition: typeof raw.linkPosition === "number" ? raw.linkPosition : undefined,
    });
  }

  return normalized.sort((a, b) => {
    const aPos = typeof a.linkPosition === "number" ? a.linkPosition : Number.MAX_SAFE_INTEGER;
    const bPos = typeof b.linkPosition === "number" ? b.linkPosition : Number.MAX_SAFE_INTEGER;
    if (aPos !== bPos) return aPos - bPos;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

function buildCommentSearchText(comment: ReviewComment, fields: Record<string, unknown>): string {
  const parts: string[] = [];
  if (comment.searchText && comment.searchText.trim().length > 0) parts.push(comment.searchText.trim());
  if (typeof fields.paragraphId === "string") parts.push(fields.paragraphId);
  if (typeof fields.threadId === "string") parts.push(fields.threadId);
  if (typeof fields.content === "string") parts.push(fields.content);
  if (typeof fields.status === "string") parts.push(fields.status);
  return parts.join(" ").trim();
}

async function markCommentsResolved(comments: ReviewComment[]): Promise<number> {
  if (comments.length === 0) return 0;

  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).contentResources.upsert as FunctionReference<"mutation">;
  let resolved = 0;

  for (const comment of comments) {
    const updatedFields = { ...comment.fields, status: "resolved" } as Record<string, unknown>;
    await client.mutation(ref, {
      resourceId: comment.resourceId,
      type: "review_comment",
      fields: updatedFields,
      searchText: buildCommentSearchText(comment, updatedFields),
    });
    resolved += 1;
  }

  return resolved;
}

function buildReviewPrompt(args: {
  target: ContentTarget;
  currentContent: string;
  comments: ReviewComment[];
  contexts: Record<string, string>;
}): string {
  const toneHint =
    args.target.contentType === "adr"
      ? "Tone: technical ADR language, concise and precise."
      : args.target.contentType === "post"
        ? "Tone: Joel blog voice (clear, direct, conversational first-person)."
        : "Tone: concise discovery-note style with practical clarity.";

  const commentsBlock = args.comments
    .map((comment, index) => {
      const context =
        args.contexts[comment.paragraphId] ?? "(Paragraph context not found in current content)";
      const createdAt =
        typeof comment.createdAt === "number" ? new Date(comment.createdAt).toISOString() : "unknown";
      return [
        `### Comment ${index + 1}`,
        `- resourceId: ${comment.resourceId}`,
        `- paragraphId: ${comment.paragraphId}`,
        `- threadId: ${comment.threadId}`,
        `- createdAt: ${createdAt}`,
        "",
        "Paragraph context:",
        context,
        "",
        "Requested change:",
        comment.content,
      ].join("\n");
    })
    .join("\n\n");

  return [
    `Content slug: ${args.target.contentSlug}`,
    `Content type: ${args.target.contentType}`,
    `Parent resourceId: ${args.target.parentResourceId}`,
    toneHint,
    "",
    "Update this content file by applying all submitted review comments.",
    "Requirements:",
    "1. Keep valid frontmatter and markdown/MDX syntax.",
    "2. Preserve intent and factual integrity.",
    "3. Incorporate each comment directly or reconcile overlapping comments.",
    "4. Return the full updated file only.",
    "",
    "## Current Content",
    "```md",
    args.currentContent.trimEnd(),
    "```",
    "",
    "## Submitted Comments",
    commentsBlock,
  ].join("\n");
}

async function runContentRewrite(systemPrompt: string, prompt: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "content-review-"));
  const promptPath = join(tempDir, "prompt.md");
  await writeFile(promptPath, prompt, "utf8");

  try {
    const promptFile = `@${promptPath}`;
    const result = await Bun.$`pi --no-session --no-extensions --print --mode json --model claude-sonnet-4-6 --system-prompt ${systemPrompt} ${promptFile}`
      .quiet()
      .nothrow();

    const stdoutRaw = readShellText(result.stdout);
    const stderr = readShellText(result.stderr).trim();
    const parsedPi = parsePiJsonAssistant(stdoutRaw);
    const assistantText = stripMarkdownFence(parsedPi?.text ?? stdoutRaw).trim();

    if (result.exitCode !== 0) {
      throw new Error(
        `pi rewrite failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
      );
    }

    if (!assistantText) {
      throw new Error("pi rewrite returned empty output");
    }

    return ensureTrailingNewline(assistantText);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function parseAdrNumber(contentSlug: string): string {
  const match = contentSlug.match(/^(\d+)/u);
  if (!match) return contentSlug;
  const prefix = match[1] ?? "";
  const parsed = Number.parseInt(prefix, 10);
  if (Number.isFinite(parsed)) return String(parsed);
  const dePadded = prefix.replace(/^0+/u, "");
  return dePadded.length > 0 ? dePadded : prefix;
}

function buildCommitMessage(target: ContentTarget, commentCount: number): string {
  if (target.contentType === "adr") {
    return `adr(${parseAdrNumber(target.contentSlug)}): review pass — ${commentCount} comments applied`;
  }
  return `${target.contentType}(${target.contentSlug}): review pass — ${commentCount} comments applied`;
}

async function commitContentUpdate(target: ContentTarget, commentCount: number): Promise<{
  committed: boolean;
  sha?: string;
}> {
  await Bun.$`cd ${target.gitRoot} && git add ${target.gitPath}`.quiet();

  const staged = await Bun.$`cd ${target.gitRoot} && git diff --cached --quiet -- ${target.gitPath}`
    .quiet()
    .nothrow();

  if (staged.exitCode === 0) {
    return { committed: false };
  }

  if (staged.exitCode !== 1) {
    const stagedError = readShellText(staged.stderr || staged.stdout).trim();
    throw new Error(
      `Failed to verify staged content changes (exit ${staged.exitCode})${stagedError ? `: ${stagedError}` : ""}`,
    );
  }

  const message = buildCommitMessage(target, commentCount);
  const commitResult = await Bun.$`cd ${target.gitRoot} && git commit -m ${message}`.quiet().nothrow();
  if (commitResult.exitCode !== 0) {
    const commitError = readShellText(commitResult.stderr || commitResult.stdout).trim();
    throw new Error(
      `git commit failed (exit ${commitResult.exitCode})${commitError ? `: ${commitError}` : ""}`,
    );
  }

  const sha = (await Bun.$`cd ${target.gitRoot} && git rev-parse HEAD`.text()).trim();
  return { committed: true, sha };
}

export const contentReviewSubmitted = inngest.createFunction(
  {
    id: "content/review-submitted",
    name: "Content Review Submitted",
    retries: 2,
    concurrency: { limit: 1, key: 'event.data.contentType + ":" + event.data.contentSlug' },
  },
  { event: "content/review.submitted" },
  async ({ event, step, gateway }) => {
    const contentSlug = event.data.contentSlug.trim();
    const contentType = parseContentType(event.data.contentType.trim());
    validateSlug(contentSlug);

    const target = await step.run("resolve-content-target", async () => {
      return resolveContentTarget(contentType, contentSlug);
    });

    try {
      const submittedComments = await step.run("load-submitted-comments", async () => {
        return querySubmittedReviewComments(target.parentResourceId);
      });

      if (submittedComments.length === 0) {
        return {
          status: "noop",
          reason: "no-submitted-comments",
          contentSlug,
          contentType,
        };
      }

      const currentContent = await step.run("read-content-file", async () => {
        const file = Bun.file(target.absolutePath);
        if (!(await file.exists())) {
          throw new NonRetriableError(`Content file not found at ${target.absolutePath}`);
        }
        return file.text();
      });

      const paragraphContexts = await step.run("map-paragraph-contexts", async () => {
        return buildParagraphContextMap(currentContent);
      });

      const reviewPrompt = await step.run("build-review-prompt", async () => {
        return buildReviewPrompt({
          target,
          currentContent,
          comments: submittedComments,
          contexts: paragraphContexts,
        });
      });

      const rewrittenContent = await step.run("rewrite-content", async () => {
        return runContentRewrite(target.systemPrompt, reviewPrompt);
      });

      const writeResult = await step.run("write-updated-content", async () => {
        if (rewrittenContent === currentContent) {
          return { updated: false };
        }
        await writeFile(target.absolutePath, rewrittenContent, "utf8");
        return { updated: true };
      });

      const commit = await step.run("commit-content-file", async () => {
        if (!writeResult.updated) {
          return { committed: false };
        }
        return commitContentUpdate(target, submittedComments.length);
      });

      const resolved = await step.run("resolve-comments", async () => {
        return markCommentsResolved(submittedComments);
      });

      await step.run("notify-gateway", async () => {
        if (!gateway) return { notified: false, reason: "gateway-unavailable" };
        await gateway.notify(
          `Content updated: ${contentSlug}. ${submittedComments.length} comments applied. ${target.url}`,
        );
        return { notified: true };
      });

      return {
        status: "completed",
        contentSlug,
        contentType,
        submitted: submittedComments.length,
        resolved,
        fileUpdated: writeResult.updated,
        commitSha: commit.sha,
        committed: commit.committed,
      };
    } catch (error) {
      const message = formatError(error);
      await step.run("alert-failure", async () => {
        if (!gateway) return { alerted: false, reason: "gateway-unavailable", error: message };
        try {
          await gateway.alert(`Content review failed for ${contentType}/${contentSlug}: ${message}`, {
            contentSlug,
            contentType,
            source: event.data.source,
          });
          return { alerted: true };
        } catch (alertError) {
          return {
            alerted: false,
            error: formatError(alertError),
          };
        }
      });
      throw error;
    }
  },
);
