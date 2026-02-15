import Link from "next/link";
import { getAllPosts } from "../lib/posts";
import { blogJsonLd } from "../lib/jsonld";

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function Home() {
  const posts = getAllPosts();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogJsonLd()) }}
      />
      <ul className="space-y-10">
        {posts.map((post) => (
          <li key={post.slug}>
            <Link href={`/${post.slug}`} className="group block">
              <div className="flex items-center gap-2">
                {post.type === "note" && (
                  <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-neutral-500 border border-neutral-800 rounded px-1.5 py-0.5">
                    note
                  </span>
                )}
                <h2 className="text-xl font-semibold tracking-tight group-hover:text-white transition-colors">
                  {post.title}
                </h2>
              </div>
              {post.description && (
                <p className="mt-1.5 text-neutral-400 leading-relaxed">{post.description}</p>
              )}
              <time dateTime={post.date} className="mt-2 block text-sm text-neutral-500">
                {formatDate(post.date)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
