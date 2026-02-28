import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import { ContentLive } from "@/components/content-live";
import { ConvexReaderProvider } from "@/components/convex-reader-provider";
import { LazyReviewGate } from "@/components/review/lazy-review-gate";
import { getAdr, getAdrSlugs } from "@/lib/adrs";
import { SITE_NAME, SITE_URL } from "@/lib/constants";
import { toDateString } from "@/lib/date";
import { mdxComponents } from "@/lib/mdx";
import { escapeMdxAngleBrackets } from "@/lib/mdx-escape";
import { rehypePlugins, remarkPlugins } from "@/lib/mdx-plugins";
import { remarkAdrLinks } from "@/lib/remark-adr-links";

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  const slugs = await getAdrSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const adr = await getAdr(slug);
  if (!adr) return {};

  const number = adr.meta.number.padStart(4, "0");
  const title = `ADR-${number}: ${adr.meta.title}`;

  return {
    title,
    openGraph: {
      type: "article",
      title,
      url: `${SITE_URL}/adrs/${slug}`,
      siteName: SITE_NAME,
    },
  };
}

const STATUS_COLORS: Record<string, string> = {
  accepted: "text-green-400 border-green-800",
  proposed: "text-yellow-400 border-yellow-800",
  shipped: "text-claw border-pink-800",
  implemented: "text-claw border-pink-800",
  deferred: "text-blue-400 border-blue-800",
  in_progress: "text-amber-400 border-amber-800",
  researching: "text-purple-400 border-purple-800",
  superseded: "text-neutral-500 border-neutral-700",
  deprecated: "text-red-400 border-red-800",
  rejected: "text-red-400 border-red-800",
  withdrawn: "text-neutral-500 border-neutral-700",
};

/** Entry: request-aware, prepares static header + dynamic MDX/review holes. */
export default async function AdrPage({ params }: Props) {
  const { slug } = await params;
  const adr = await getAdr(slug);
  if (!adr) notFound();

  const { meta, content } = adr;
  const number = meta.number.padStart(4, "0");
  const statusClass =
    STATUS_COLORS[meta.status] ?? "text-neutral-500 border-neutral-700";

  return (
    <article
      className="mx-auto max-w-2xl"
      data-pagefind-body
      data-pagefind-meta={`type:ADR, status:${meta.status}`}
    >
      {/* Realtime: refresh page when content changes in Convex */}
      <ConvexReaderProvider>
        <ContentLive resourceId={`adr:${slug}`} />
      </ConvexReaderProvider>

      {/* Static shell: header renders immediately */}
      <header className="mb-10">
        <div className="flex items-center gap-3 mb-2">
          <span className="font-mono text-sm text-neutral-500">
            ADR-{number}
          </span>
          <span
            className={`text-[11px] font-medium uppercase tracking-wider border rounded px-1.5 py-0.5 ${statusClass}`}
          >
            {meta.status}
          </span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{meta.title}</h1>
        {meta.date && (
          <time className="mt-2 block text-sm text-neutral-500">
            {toDateString(meta.date)}
          </time>
        )}
        {meta.supersededBy && (
          <p className="mt-2 text-sm text-neutral-500 italic">
            Superseded by {meta.supersededBy}
          </p>
        )}
      </header>

      <LazyReviewGate
        contentId={`adr:${slug}`}
        contentType="adr"
        contentSlug={slug}
      >
        <AdrContent content={content} />
      </LazyReviewGate>
    </article>
  );
}

/** MDX rendering for static ADR content. */
async function AdrContent({ content }: { content: string }) {
  "use cache";

  return (
    <div className="prose-joelclaw">
      <MDXRemote
        source={escapeMdxAngleBrackets(
          content.replace(/^#\s+(?:ADR-\d+:\s*)?.*$/m, "").trim()
        )}
        components={mdxComponents}
        options={{
          mdxOptions: {
            remarkPlugins: [...remarkPlugins, remarkAdrLinks],
            rehypePlugins,
            format: "md",
          },
        }}
      />
    </div>
  );
}
