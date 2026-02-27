import type { Metadata } from "next";
import Link from "next/link";
import { SITE_NAME } from "@/lib/constants";
import { formatDateStatic } from "@/lib/date";
import { getAllDiscoveries } from "@/lib/discoveries";

export const metadata: Metadata = {
  title: `Cool Finds — ${SITE_NAME}`,
  description:
    "Interesting repos, tools, articles, and ideas — captured and investigated by agents.",
};

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  repo: { label: "repo", cls: "bg-blue-950 text-blue-400" },
  article: { label: "article", cls: "bg-green-950 text-green-400" },
  tool: { label: "tool", cls: "bg-purple-950 text-purple-400" },
  video: { label: "video", cls: "bg-red-950 text-red-400" },
};

function typeBadge(tags: string[]) {
  for (const t of tags) {
    if (TYPE_BADGE[t]) return TYPE_BADGE[t];
  }
  return { label: "find", cls: "bg-neutral-800 text-neutral-400" };
}

function discoveryDate(iso: string): string {
  return formatDateStatic(iso, { monthStyle: "short", includeYear: false });
}

export default function CoolPage() {
  const discoveries = getAllDiscoveries();

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Cool Finds</h1>
        <p className="mt-1.5 text-sm text-neutral-500">
          Interesting repos, tools, articles, and ideas — captured by agents
          when something catches my eye.
        </p>
      </header>
      <div className="space-y-3">
        {discoveries.map((d) => {
          const badge = typeBadge(d.tags);
          return (
            <article key={d.slug} className="group">
              <Link
                href={`/cool/${d.slug}`}
                className="block rounded-lg border border-neutral-800 px-4 py-3.5 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wider rounded px-1.5 py-0.5 ${badge.cls}`}
                  >
                    {badge.label}
                  </span>
                  <span className="text-[11px] text-neutral-600 tabular-nums">
                    {d.discovered ? discoveryDate(d.discovered) : ""}
                  </span>
                </div>
                <h2 className="text-[15px] font-semibold leading-snug text-neutral-200 group-hover:text-white transition-colors">
                  {d.title}
                </h2>
                <p className="mt-1 text-[13px] leading-relaxed text-neutral-500">
                  {d.relevance}
                </p>
              </Link>
            </article>
          );
        })}
        {discoveries.length === 0 && (
          <p className="text-neutral-500 text-sm">No discoveries yet.</p>
        )}
      </div>
    </div>
  );
}
