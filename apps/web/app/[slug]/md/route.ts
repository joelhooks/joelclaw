import { getPost, getPostSlugs } from "../../../lib/posts";
import { SITE_URL } from "../../../lib/constants";

export async function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
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

  return new Response(header + content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate",
    },
  });
}
