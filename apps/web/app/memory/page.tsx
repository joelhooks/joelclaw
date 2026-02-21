"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { authClient } from "../../lib/auth-client";
import { Brain } from "lucide-react";

type Observation = {
  id: string;
  observation: string;
  category: string;
  source: string;
  timestamp: number;
  superseded: boolean;
};

const CATEGORY_COLORS: Record<string, string> = {
  debugging: "text-red-400 bg-red-500/10",
  architecture: "text-blue-400 bg-blue-500/10",
  preference: "text-purple-400 bg-purple-500/10",
  workflow: "text-emerald-400 bg-emerald-500/10",
  tool: "text-amber-400 bg-amber-500/10",
  decision: "text-cyan-400 bg-cyan-500/10",
};

export default function MemoryPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const isOwner = useQuery(api.auth.isOwner);
  const [data, setData] = useState<{ hits: Observation[]; found: number } | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!isOwner) return;
    const q = query.trim() || "*";
    fetch(`/api/typesense/memory_observations?q=${encodeURIComponent(q)}&page=${page}&per_page=50`)
      .then((r) => r.json())
      .then((d) =>
        setData({
          hits: (d.hits || []).map((h: any) => ({ id: h.document.id, ...h.document })),
          found: d.found || 0,
        })
      )
      .catch(() => {});
  }, [isOwner, query, page]);

  if (isPending || isOwner === undefined) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-neutral-700 border-t-claw" />
      </div>
    );
  }
  if (!session?.user || !isOwner) {
    router.replace("/");
    return null;
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Brain className="w-6 h-6 text-amber-400" />
        <h1 className="font-mono text-xl font-bold text-neutral-100">Memory</h1>
        {data && (
          <span className="font-mono text-sm text-neutral-500">
            {data.found} observations
          </span>
        )}
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setPage(1); }}
        placeholder="search observations..."
        className="w-full rounded-lg border border-neutral-700/50 bg-neutral-950 px-4 py-2.5 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
      />

      <div className="space-y-2">
        {data?.hits.map((obs) => (
          <div
            key={obs.id}
            className={`rounded-lg border border-neutral-700/30 bg-neutral-900/30 p-4 space-y-2 ${obs.superseded ? "opacity-50" : ""}`}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`rounded px-1.5 py-0.5 font-pixel text-[10px] uppercase tracking-wider ${CATEGORY_COLORS[obs.category] || "text-neutral-400 bg-neutral-500/10"}`}>
                {obs.category}
              </span>
              <span className="font-mono text-[10px] text-neutral-500">{obs.source}</span>
              {obs.superseded && (
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-pixel text-[9px] text-neutral-500">superseded</span>
              )}
              <span className="ml-auto font-mono text-[10px] text-neutral-600">
                {new Date(obs.timestamp * 1000).toLocaleString()}
              </span>
            </div>
            <p className="font-mono text-sm leading-relaxed text-neutral-300">
              {obs.observation}
            </p>
          </div>
        ))}
      </div>

      {data && data.found > 50 && (
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="rounded border border-neutral-700 px-3 py-1.5 font-mono text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
          >
            ← prev
          </button>
          <span className="font-mono text-xs text-neutral-500">
            page {page} of {Math.ceil(data.found / 50)}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= Math.ceil(data.found / 50)}
            className="rounded border border-neutral-700 px-3 py-1.5 font-mono text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
          >
            next →
          </button>
        </div>
      )}
    </div>
  );
}
