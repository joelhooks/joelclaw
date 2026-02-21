import type { Metadata } from "next";
import Link from "next/link";
import { getAllDiscoveries } from "../../lib/discoveries";
import { SITE_NAME } from "../../lib/constants";

export const metadata: Metadata = {
  title: `Cool Finds — ${SITE_NAME}`,
  description:
    "Interesting repos, tools, articles, and ideas — captured and investigated by agents.",
};

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

export default function CoolPage() {
  const discoveries = getAllDiscoveries();

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-10">
        <h1 className="text-2xl font-bold tracking-tight">Cool Finds</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Interesting repos, tools, articles, and ideas. Captured by saying
          &ldquo;interesting&rdquo; in conversation — agents investigate and
          write the notes in the background.
        </p>
      </header>
      <div className="space-y-6">
        {discoveries.map((d) => (
          <article key={d.slug} className="group">
            <Link
              href={`/cool/${d.slug}`}
              className="block rounded-lg border border-neutral-800 px-5 py-4 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold group-hover:text-white transition-colors truncate">
                    {d.title}
                  </h2>
                  <p className="mt-1 text-sm text-neutral-400 line-clamp-2">
                    {d.relevance}
                  </p>
                </div>
                {d.discovered && (
                  <time className="shrink-0 text-xs text-neutral-600 tabular-nums">
                    {d.discovered}
                  </time>
                )}
              </div>
              {d.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {d.tags.map((tag) => (
                    <span
                      key={tag}
                      className={`text-[10px] font-medium uppercase tracking-wider border rounded px-1.5 py-0.5 ${tagColor(tag)}`}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {d.source && (
                <p className="mt-2 text-xs text-neutral-600 truncate font-mono">
                  {d.source}
                </p>
              )}
            </Link>
          </article>
        ))}
        {discoveries.length === 0 && (
          <p className="text-neutral-500 text-sm">No discoveries yet.</p>
        )}
      </div>
    </div>
  );
}
