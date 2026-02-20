import { getPost, getPostSlugs } from "../../../lib/posts";
import { SITE_URL } from "../../../lib/constants";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import { remarkMdLinks } from "../../../lib/remark-md-links";
import { remarkStripMdxComments } from "../../../lib/remark-strip-mdx-comments";
import { remarkStripAgentOnly } from "../../../lib/remark-strip-agent-only";

export async function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
}

/** Process MDX content through remark pipeline for human-safe markdown output */
async function toCleanMarkdown(mdxContent: string): Promise<string> {
  const result = await remark()
    .use(remarkMdx) // parse MDX syntax so expression nodes are in the AST
    .use(remarkStripMdxComments) // remove {/* ... */} comment blocks
    .use(remarkStripAgentOnly) // remove <AgentOnly> blocks for humans
    .use(remarkGfm) // tables, strikethrough, task lists
    .use(remarkMdLinks, { mode: "human" }) // rewrite internal links to .md endpoints
    .process(mdxContent);

  return String(result);
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
  const cleaned = await toCleanMarkdown(content);

  const header = [
    `# ${meta.title}`,
    "",
    `> ${meta.description}`,
    "",
    `By Joel Hooks · ${meta.date}`,
    `Original: ${SITE_URL}/${meta.slug}`,
    "",
    "---",
    "",
  ].join("\n");

  return new Response(header + cleaned, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate",
    },
  });
}
