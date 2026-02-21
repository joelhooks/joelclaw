"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { authClient } from "../../lib/auth-client";
import { Terminal } from "lucide-react";

const ACTION_COLORS: Record<string, string> = {
  install: "text-emerald-400 bg-emerald-500/10",
  configure: "text-blue-400 bg-blue-500/10",
  remove: "text-red-400 bg-red-500/10",
  fix: "text-amber-400 bg-amber-500/10",
  upgrade: "text-cyan-400 bg-cyan-500/10",
  deploy: "text-purple-400 bg-purple-500/10",
};

export default function SyslogPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const isOwner = useQuery(api.auth.isOwner);
  const [query, setQuery] = useState("");
  const [toolFilter, setToolFilter] = useState<string | undefined>();

  const listData = useQuery(
    api.contentResources.listByType,
    !query.trim() ? { type: "system_log", limit: 300 } : "skip"
  );
  const searchData = useQuery(
    api.contentResources.searchByType,
    query.trim().length > 1
      ? { type: "system_log", query: query.trim(), limit: 300 }
      : "skip"
  );

  const rawEntries = query.trim().length > 1 ? searchData : listData;
  const allEntries = (rawEntries ?? [])
    .map((doc) => {
      const fields = (doc.fields ?? {}) as Record<string, unknown>;
      return {
        resourceId: doc.resourceId,
        action: String(fields.action ?? ""),
        tool: String(fields.tool ?? ""),
        detail: String(fields.detail ?? ""),
        reason: fields.reason ? String(fields.reason) : undefined,
        timestamp: Number(fields.timestamp ?? 0),
      };
    });
  const entries = allEntries.filter((entry) => (toolFilter ? entry.tool === toolFilter : true));

  // Derive unique tools from data for filter chips
  const tools = allEntries.length > 0
    ? [...new Set(allEntries.map((e) => e.tool))].sort()
    : [];

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
        <Terminal className="w-6 h-6 text-blue-400" />
        <h1 className="font-mono text-xl font-bold text-neutral-100">System Log</h1>
        {entries && (
          <span className="font-mono text-sm text-neutral-500">
            {entries.length} entries
          </span>
        )}
      </div>

      <div className="flex gap-3 flex-wrap">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search syslog..."
          className="flex-1 min-w-[200px] rounded-lg border border-neutral-700/50 bg-neutral-950 px-4 py-2.5 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
        />
        {tools.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => setToolFilter(undefined)}
              className={`rounded px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${!toolFilter ? "bg-neutral-700 text-neutral-200" : "bg-neutral-800/40 text-neutral-500 hover:text-neutral-300"}`}
            >
              all
            </button>
            {tools.slice(0, 10).map((t) => (
              <button
                key={t}
                onClick={() => setToolFilter(toolFilter === t ? undefined : t)}
                className={`rounded px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${toolFilter === t ? "bg-neutral-700 text-neutral-200" : "bg-neutral-800/40 text-neutral-500 hover:text-neutral-300"}`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        {rawEntries === undefined ? (
          <div className="space-y-1">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-neutral-800/30" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-700/40 p-8 text-center">
            <p className="font-mono text-sm text-neutral-500">no entries found</p>
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.resourceId}
              className="rounded-lg border border-neutral-700/30 bg-neutral-900/30 px-4 py-3 space-y-1.5"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`rounded px-1.5 py-0.5 font-pixel text-[10px] uppercase tracking-wider ${ACTION_COLORS[entry.action] || "text-neutral-400 bg-neutral-500/10"}`}>
                  {entry.action}
                </span>
                <span className="rounded bg-neutral-800/60 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
                  {entry.tool}
                </span>
                <span className="ml-auto font-mono text-[10px] text-neutral-600">
                  {new Date(entry.timestamp * 1000).toLocaleString()}
                </span>
              </div>
              <p className="font-mono text-sm leading-relaxed text-neutral-300">
                {entry.detail}
              </p>
              {entry.reason && (
                <p className="font-mono text-xs text-neutral-500 italic">
                  → {entry.reason}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
