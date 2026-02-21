"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { authClient } from "../../lib/auth-client";
import { Terminal } from "lucide-react";

type LogEntry = {
  id: string;
  action: string;
  tool: string;
  detail: string;
  reason: string;
  timestamp: number;
};

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
  const [data, setData] = useState<{ hits: LogEntry[]; found: number } | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!isOwner) return;
    const q = query.trim() || "*";
    fetch(`/api/typesense/system_log?q=${encodeURIComponent(q)}&page=${page}&per_page=50`)
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
        <Terminal className="w-6 h-6 text-blue-400" />
        <h1 className="font-mono text-xl font-bold text-neutral-100">System Log</h1>
        {data && (
          <span className="font-mono text-sm text-neutral-500">
            {data.found} entries
          </span>
        )}
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setPage(1); }}
        placeholder="search syslog..."
        className="w-full rounded-lg border border-neutral-700/50 bg-neutral-950 px-4 py-2.5 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
      />

      <div className="space-y-1">
        {data?.hits.map((entry) => (
          <div
            key={entry.id}
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
