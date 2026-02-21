import Link from "next/link";
import { getAllPosts } from "../lib/posts";
import { blogJsonLd } from "../lib/jsonld";
import { RelativeTime } from "../lib/relative-time";

export default function Home() {
  const posts = getAllPosts();

  return (
    <div className="mx-auto max-w-2xl">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogJsonLd()) }}
      />
      <ul className="space-y-10">
        {posts.map((post) => (
          <li key={post.slug}>
            <Link href={`/${post.slug}`} className="group block">
              <div className="flex items-center gap-2">
                {post.type !== "article" && (
                  <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-neutral-500 border border-neutral-800 rounded px-1.5 py-0.5">
                    {post.type}
                  </span>
                )}
                <h2 className="text-xl font-semibold tracking-tight group-hover:text-white transition-colors">
                  {post.title}
                </h2>
              </div>
              {post.description && (
                <p className="mt-1.5 text-neutral-400 leading-relaxed">{post.description}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <RelativeTime date={post.date} className="text-sm text-neutral-500" />
                {post.tags.length > 0 && (
                  <>
                    <span className="text-neutral-700">·</span>
                    {post.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="text-[11px] font-medium text-neutral-600 border border-neutral-800 rounded px-1.5 py-0.5">
                        {tag}
                      </span>
                    ))}
                  </>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
