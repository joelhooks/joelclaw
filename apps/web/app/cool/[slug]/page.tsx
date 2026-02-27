import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import { SITE_NAME, SITE_URL } from "@/lib/constants";
import { getDiscovery, getDiscoverySlugs } from "@/lib/discoveries";
import { mdxComponents } from "@/lib/mdx";
import { rehypePlugins, remarkPlugins } from "@/lib/mdx-plugins";

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  return getDiscoverySlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const discovery = getDiscovery(slug);
  if (!discovery) return {};

  return {
    title: `${discovery.meta.title} — ${SITE_NAME}`,
    description: discovery.meta.relevance,
    openGraph: {
      type: "article",
      title: discovery.meta.title,
      url: `${SITE_URL}/cool/${slug}`,
      siteName: SITE_NAME,
    },
  };
}

function tagColor(tag: string): string {
  const colors: Record<string, string> = {
    repo: "text-blue-400 border-blue-800",
    article: "text-green-400 border-green-800",
    tool: "text-purple-400 border-purple-800",
    ai: "text-yellow-400 border-yellow-800",
    cli: "text-orange-400 border-orange-800",
    typescript: "text-sky-400 border-sky-800",
    go: "text-cyan-400 border-cyan-800",
    pattern: "text-pink-400 border-pink-800",
  };
  return colors[tag] ?? "text-neutral-500 border-neutral-700";
}

export default async function DiscoveryPage({ params }: Props) {
  const { slug } = await params;
  const discovery = getDiscovery(slug);
  if (!discovery) notFound();

  const { meta, content } = discovery;

  return (
    <article className="mx-auto max-w-2xl" data-pagefind-body data-pagefind-meta="type:discovery">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight">{meta.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-neutral-500">
          {meta.discovered && (
            <time className="tabular-nums">{meta.discovered}</time>
          )}
          {meta.source && (
            <>
              <span className="text-neutral-700">·</span>
              <a
                href={meta.source}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-white transition-colors font-mono text-xs truncate max-w-sm"
              >
                {meta.source}
              </a>
            </>
          )}
        </div>
        {meta.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {meta.tags.map((tag) => (
              <span
                key={tag}
                className={`text-[10px] font-medium uppercase tracking-wider border rounded px-1.5 py-0.5 ${tagColor(tag)}`}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        {meta.relevance && (
          <p className="mt-4 text-sm text-neutral-400 italic">
            {meta.relevance}
          </p>
        )}
      </header>
      <DiscoveryContent content={content} />
      <div className="mt-12 pt-6 border-t border-neutral-800">
        <Link
          href="/cool"
          className="text-sm text-neutral-500 hover:text-white transition-colors"
        >
          ← All discoveries
        </Link>
      </div>
    </article>
  );
}

async function DiscoveryContent({ content }: { content: string }) {
  "use cache";

  return (
    <div className="prose-joelclaw">
      <MDXRemote
        source={content}
        components={mdxComponents}
        options={{
          mdxOptions: { remarkPlugins, rehypePlugins, format: "md" },
        }}
      />
    </div>
  );
}
