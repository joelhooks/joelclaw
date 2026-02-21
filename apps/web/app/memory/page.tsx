"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { authClient } from "../../lib/auth-client";
import { Brain } from "lucide-react";

const CATEGORY_COLORS: Record<string, string> = {
  debugging: "text-red-400 bg-red-500/10",
  architecture: "text-blue-400 bg-blue-500/10",
  preference: "text-purple-400 bg-purple-500/10",
  workflow: "text-emerald-400 bg-emerald-500/10",
  tool: "text-amber-400 bg-amber-500/10",
  decision: "text-cyan-400 bg-cyan-500/10",
  general: "text-neutral-400 bg-neutral-500/10",
};

export default function MemoryPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const isOwner = useQuery(api.auth.isOwner);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | undefined>();

  const listData = useQuery(
    api.memoryObservations.list,
    !query.trim() ? { category, limit: 100 } : "skip"
  );
  const searchData = useQuery(
    api.memoryObservations.search,
    query.trim().length > 1 ? { query: query.trim(), limit: 100 } : "skip"
  );

  const observations = query.trim().length > 1 ? searchData : listData;

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

  const categories = ["debugging", "architecture", "preference", "workflow", "tool", "decision"];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Brain className="w-6 h-6 text-amber-400" />
        <h1 className="font-mono text-xl font-bold text-neutral-100">Memory</h1>
        {observations && (
          <span className="font-mono text-sm text-neutral-500">
            {observations.length} observations
          </span>
        )}
      </div>

      <div className="flex gap-3 flex-wrap">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search observations..."
          className="flex-1 min-w-[200px] rounded-lg border border-neutral-700/50 bg-neutral-950 px-4 py-2.5 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
        />
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => setCategory(undefined)}
            className={`rounded px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${!category ? "bg-neutral-700 text-neutral-200" : "bg-neutral-800/40 text-neutral-500 hover:text-neutral-300"}`}
          >
            all
          </button>
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(category === c ? undefined : c)}
              className={`rounded px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${category === c ? "bg-neutral-700 text-neutral-200" : "bg-neutral-800/40 text-neutral-500 hover:text-neutral-300"}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {observations === undefined ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-neutral-800/30" />
            ))}
          </div>
        ) : observations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-700/40 p-8 text-center">
            <p className="font-mono text-sm text-neutral-500">no observations found</p>
          </div>
        ) : (
          observations.map((obs) => (
            <div
              key={obs._id}
              className={`rounded-lg border border-neutral-700/30 bg-neutral-900/30 p-4 space-y-2 ${obs.superseded ? "opacity-50" : ""}`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`rounded px-1.5 py-0.5 font-pixel text-[10px] uppercase tracking-wider ${CATEGORY_COLORS[obs.category] || CATEGORY_COLORS.general}`}>
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
          ))
        )}
      </div>
    </div>
  );
}
