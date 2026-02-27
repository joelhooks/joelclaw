import { getPostSlugs } from "@/lib/posts";

export async function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  return Response.redirect(new URL(`/${slug}.md`, req.url), 301);
}
