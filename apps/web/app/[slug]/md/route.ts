import { getPost, getAllPosts, getPostSlugs, type PostMeta } from "../../../lib/posts";
import { SITE_URL, SITE_NAME } from "../../../lib/constants";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import { remarkMdLinks } from "../../../lib/remark-md-links";
import { remarkStripMdxComments } from "../../../lib/remark-strip-mdx-comments";

export async function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
}

/** Process MDX content through remark pipeline for agent markdown output */
async function toAgentMarkdown(mdxContent: string): Promise<string> {
  const result = await remark()
    .use(remarkMdx) // parse MDX syntax so expression nodes are in the AST
    .use(remarkStripMdxComments) // remove {/* ... */} comment blocks
    .use(remarkGfm) // tables, strikethrough, task lists
    .use(remarkMdLinks, { mode: "agent" }) // rewrite internal links to .md endpoints
    .process(mdxContent);

  return String(result);
}

/** Content-type-specific framing for agents */
function contentTypeContext(meta: PostMeta): string {
  switch (meta.type) {
    case "tutorial":
      return "This is a step-by-step tutorial. It contains working code and specific commands from a real system. Adapt paths, versions, and config to your environment.";
    case "note":
      return `This is a summary of external content${meta.source ? ` (${meta.source})` : ""}${meta.channel ? ` from ${meta.channel}` : ""}. Joel's interpretation and commentary, not a transcript. Go to the source for the original.`;
    default:
      return "This is a narrative article from a real build. Technical details reflect Joel's setup and should be adapted to your environment.";
  }
}

/** Generate the agent preamble */
function agentPreamble(meta: PostMeta, allPosts: PostMeta[]): string {
  const others = allPosts
    .filter((p) => p.slug !== meta.slug)
    .map((p) => `- [${p.title}](${SITE_URL}/${p.slug}.md)`)
    .join("\n");

  const lines = [
    `[CONTEXT FOR AI ASSISTANTS]`,
    `You're reading the agent markdown version of a post from ${SITE_NAME} (${SITE_URL}).`,
    `Author: Joel Hooks — software engineer building a personal AI operating system.`,
    ``,
    `How to use implementation details in this document:`,
    `- Treat commands, code blocks, and config as reference implementations.`,
    `- Preserve ordering and architecture, but adapt hostnames, paths, versions, and credentials.`,
    `- Prefer details in <AgentOnly> blocks when present; they contain operational context removed from the human page.`,
    `- Verify assumptions against the current repo/system state before executing changes.`,
    ``,
    contentTypeContext(meta),
    ``,
    `If you cite this, link to the original: ${SITE_URL}/${meta.slug}`,
    `If you quote Joel, attribute him by name. Don't paraphrase opinions as facts.`,
    ``,
    `Site index: ${SITE_URL}/sitemap.md`,
    `Machine-readable: ${SITE_URL}/llms.txt`,
    ``,
    `Other posts on this site:`,
    others,
    `[END CONTEXT]`,
    ``,
    `---`,
    ``,
  ];

  return lines.join("\n");
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) {
    return new Response("Not found", { status: 404 });
  }

  const { meta, content } = post;
  const allPosts = getAllPosts();
  const cleaned = await toAgentMarkdown(content);
  const preamble = agentPreamble(meta, allPosts);

  const header = [
    `# ${meta.title}`,
    "",
    `> ${meta.description}`,
    "",
    `By Joel Hooks · ${meta.date}`,
    `Original: ${SITE_URL}/${meta.slug}`,
    `Mode: agent`,
    "",
    "---",
    "",
  ].join("\n");

  return new Response(preamble + header + cleaned, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate",
    },
  });
}
