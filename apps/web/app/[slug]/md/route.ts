import { getPost, getPostSlugs, getPostSlugs as getAllSlugs } from "../../../lib/posts";
import { SITE_URL } from "../../../lib/constants";

export async function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
}

/** Rewrite internal links to their /md markdown versions.
 *  `[text](/some-slug)` → `[text](https://joelclaw.com/some-slug/md)`
 *  Only rewrites links whose path matches a known post or ADR slug. */
function rewriteInternalLinks(markdown: string): string {
  const slugs = new Set(getAllSlugs());
  // Match markdown links with relative paths: [text](/path) or [text](/path#anchor)
  return markdown.replace(
    /\[([^\]]+)\]\(\/([\w-]+(?:\/[\w-]+)?)(#[^\)]+)?\)/g,
    (match, text, path, anchor) => {
      // Post slugs — rewrite to /md
      if (slugs.has(path)) {
        return `[${text}](${SITE_URL}/${path}/md${anchor ?? ""})`;
      }
      // ADR links (/adrs/NNNN-slug) — keep as full URLs (no /md route for ADRs)
      if (path.startsWith("adrs/")) {
        return `[${text}](${SITE_URL}/${path}${anchor ?? ""})`;
      }
      // Other internal links — just make absolute
      return `[${text}](${SITE_URL}/${path}${anchor ?? ""})`;
    }
  );
}

/** Strip MDX comment blocks: {/* ... *\/} */
function stripMdxComments(markdown: string): string {
  return markdown.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
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
  const cleaned = stripMdxComments(rewriteInternalLinks(content));

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
