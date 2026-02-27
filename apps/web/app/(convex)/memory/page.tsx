"use client";

import { PageHeader } from "@repo/ui/page-header";
import { SearchBar } from "@repo/ui/search-bar";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { authClient } from "@/lib/auth-client";

const CATEGORY_COLORS: Record<string, string> = {
  debugging: "text-red-400 bg-red-500/10",
  architecture: "text-blue-400 bg-blue-500/10",
  preference: "text-purple-400 bg-purple-500/10",
  workflow: "text-emerald-400 bg-emerald-500/10",
  tool: "text-amber-400 bg-amber-500/10",
  decision: "text-cyan-400 bg-cyan-500/10",
  general: "text-neutral-400 bg-neutral-500/10",
};

function formatUnixSeconds(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  if (typeof window === "undefined") return String(ts);
  return new Date(ts * 1000).toLocaleString();
}

export default function MemoryPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const isOwner = useQuery(api.auth.isOwner);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | undefined>();

  const listData = useQuery(
    api.contentResources.listByType,
    !query.trim() ? { type: "memory_observation", limit: 300 } : "skip"
  );
  const searchData = useQuery(
    api.contentResources.searchByType,
    query.trim().length > 1
      ? { type: "memory_observation", query: query.trim(), limit: 300 }
      : "skip"
  );

  const rawObservations = query.trim().length > 1 ? searchData : listData;
  const observations = (rawObservations ?? [])
    .map((doc) => {
      const fields = (doc.fields ?? {}) as Record<string, unknown>;
      return {
        resourceId: doc.resourceId,
        observation: String(fields.observation ?? ""),
        category: String(fields.category ?? "general"),
        source: String(fields.source ?? "unknown"),
        superseded: Boolean(fields.superseded ?? false),
        timestamp: Number(fields.timestamp ?? 0),
      };
    })
    .filter((obs) => (category ? obs.category === category : true));

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
    <div className="mx-auto max-w-[1800px] space-y-6">
      <PageHeader title="Memory" count={observations?.length} />

      <div className="flex gap-3 flex-wrap">
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder="search observations..."
          className="flex-1 min-w-[200px]"
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
        {rawObservations === undefined ? (
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
              key={obs.resourceId}
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
                  {formatUnixSeconds(obs.timestamp)}
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
