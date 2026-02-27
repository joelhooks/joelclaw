import type { Metadata } from "next";
import { cacheLife, cacheTag } from "next/cache";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import { Suspense } from "react";
import { LazyReviewGate } from "@/components/review/lazy-review-gate";
import { SITE_NAME, SITE_URL } from "@/lib/constants";
import { blogPostingJsonLd, breadcrumbJsonLd } from "@/lib/jsonld";
import { mdxComponents } from "@/lib/mdx";
import { rehypePlugins, remarkPlugins } from "@/lib/mdx-plugins";
import { getPost, getPostSlugs } from "@/lib/posts";
import { RelativeTime } from "@/lib/relative-time";

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  const slugs = await getPostSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
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
      ...(meta.image
        ? { images: [{ url: `${SITE_URL}${meta.image}`, width: 1200, height: 630 }] }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
      ...(meta.image ? { images: [`${SITE_URL}${meta.image}`] } : {}),
    },
    alternates: {
      canonical: url,
    },
  };
}


export default async function PostPage({ params }: Props) {
  const { slug } = await params;
  return <PostPageLayout slug={slug} />;
}

function PostPageLayout({ slug }: { slug: string }) {
  return (
    <>
      <Suspense fallback={<ArticleFallback />}>
        <CachedArticleContent slug={slug} />
      </Suspense>

      {/* Reserved dynamic slot for future FeedbackStatus streaming UI. */}
      <Suspense fallback={null}>
        <FeedbackStatusSlot slug={slug} />
      </Suspense>
    </>
  );
}

async function CachedArticleContent({ slug }: { slug: string }) {
  "use cache";
  cacheLife("max");
  cacheTag(`article:${slug}`);

  const post = await getPost(slug);
  if (!post) notFound();

  const { meta, content } = post;

  const postJsonLd = blogPostingJsonLd(meta);
  const breadcrumbs = breadcrumbJsonLd([
    { name: SITE_NAME, url: SITE_URL },
    { name: meta.title, url: `${SITE_URL}/${meta.slug}` },
  ]);

  return (
    <article className="mx-auto max-w-2xl" data-pagefind-body data-pagefind-meta={`type:${meta.type}`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(postJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbs) }}
      />
      <header className="mb-10">
        {meta.type !== "article" && (
          <span className="inline-block text-[11px] font-medium uppercase tracking-wider text-neutral-500 border border-neutral-800 rounded px-1.5 py-0.5 mb-3">
            {meta.type}
          </span>
        )}
        <h1 className="text-3xl font-bold tracking-tight">{meta.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
          <RelativeTime date={meta.date} />
          {meta.updated && (
            <span>
              · updated <RelativeTime date={meta.updated} />
            </span>
          )}
          {meta.channel && <span>· {meta.channel}</span>}
          {meta.duration && <span>· {meta.duration}</span>}
        </div>
        {meta.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {meta.tags.map((tag) => (
              <span key={tag} className="text-[11px] font-medium text-neutral-500 border border-neutral-800 rounded px-1.5 py-0.5">
                {tag}
              </span>
            ))}
          </div>
        )}
      </header>
      <LazyReviewGate
        contentId={`post:${slug}`}
        contentType="post"
        contentSlug={slug}
      >
        <PostContent content={content} />
      </LazyReviewGate>
    </article>
  );
}

/** MDX rendering for static post content. */
function PostContent({ content }: { content: string }) {
  return (
    <div className="prose-joelclaw">
      <MDXRemote
        source={content}
        components={mdxComponents}
        options={{ mdxOptions: { remarkPlugins, rehypePlugins } }}
      />
    </div>
  );
}

function ArticleFallback() {
  return <article className="mx-auto max-w-2xl" data-pagefind-body />;
}

async function FeedbackStatusSlot(_props: { slug: string }) {
  return null;
}
