export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  return Response.redirect(new URL(`/${slug}.md`, req.url), 301);
}
