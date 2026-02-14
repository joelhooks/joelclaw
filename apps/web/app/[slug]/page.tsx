import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { MDXRemote } from "next-mdx-remote/rsc";
import { getPost, getPostSlugs } from "../../lib/posts";
import { mdxComponents } from "../../lib/mdx";
import { blogPostingJsonLd, breadcrumbJsonLd } from "../../lib/jsonld";
import { SITE_URL, SITE_NAME } from "../../lib/constants";

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};

  const { meta } = post;
  const url = `${SITE_URL}/${meta.slug}`;

  return {
    title: meta.title,
    description: meta.description,
    openGraph: {
      type: "article",
      title: meta.title,
      description: meta.description,
      url,
      publishedTime: meta.date,
      authors: [SITE_URL],
      siteName: SITE_NAME,
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
    },
    alternates: {
      canonical: url,
    },
  };
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function PostPage({ params }: Props) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  const { meta, content } = post;

  const postJsonLd = blogPostingJsonLd(meta);
  const breadcrumbs = breadcrumbJsonLd([
    { name: SITE_NAME, url: SITE_URL },
    { name: meta.title, url: `${SITE_URL}/${meta.slug}` },
  ]);

  return (
    <article>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(postJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbs) }}
      />
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight">{meta.title}</h1>
        <time dateTime={meta.date} className="mt-2 block text-sm text-neutral-500">
          {formatDate(meta.date)}
        </time>
      </header>
      <div className="prose-joelclaw">
        <MDXRemote source={content} components={mdxComponents} />
      </div>
    </article>
  );
}
