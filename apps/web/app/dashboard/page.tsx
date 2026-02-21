"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useState, useCallback } from "react";

// ── Status indicator ────────────────────────────────────────────

function Pulse({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy: "bg-emerald-500 shadow-emerald-500/50",
    degraded: "bg-amber-500 shadow-amber-500/50",
    down: "bg-red-500 shadow-red-500/50",
  };
  return (
    <span className="relative flex h-2 w-2">
      {status === "healthy" && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
      )}
      <span
        className={`relative inline-flex h-2 w-2 rounded-full shadow-sm ${colors[status] || colors.down}`}
      />
    </span>
  );
}

// ── System Health Panel ─────────────────────────────────────────

function SystemHealth() {
  const status = useQuery(api.systemStatus.list);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600">
          Infrastructure
        </h2>
        <div className="h-px flex-1 bg-neutral-800/40" />
      </div>

      {!status ? (
        <div className="grid grid-cols-2 gap-2">
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-lg border border-neutral-800/40 bg-neutral-900/30"
            />
          ))}
        </div>
      ) : status.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800/60 p-6 text-center">
          <p className="font-mono text-xs text-neutral-600">
            awaiting first heartbeat
          </p>
          <p className="mt-1 font-mono text-[10px] text-neutral-700">
            health data populates on next cron cycle
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {status.map((s) => (
            <div
              key={s._id}
              className="group flex items-center gap-3 rounded-lg border border-neutral-800/40 bg-neutral-900/20 px-3 py-2.5 transition-colors hover:border-neutral-700/60 hover:bg-neutral-900/40"
            >
              <Pulse status={s.status} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs text-neutral-300">
                  {s.component}
                </p>
                {s.detail && (
                  <p className="truncate font-mono text-[10px] text-neutral-600">
                    {s.detail}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Notification Feed ───────────────────────────────────────────

function NotificationFeed() {
  const notifications = useQuery(api.notifications.list, { limit: 8 });
  const unreadCount = useQuery(api.notifications.unreadCount);

  const typeIcons: Record<string, string> = {
    deploy: "▲",
    loop: "⟳",
    email: "✉",
    observation: "◉",
    error: "✕",
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600">
          Activity
        </h2>
        {unreadCount != null && unreadCount > 0 && (
          <span className="rounded-full bg-claw/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-claw">
            {unreadCount}
          </span>
        )}
        <div className="h-px flex-1 bg-neutral-800/40" />
      </div>

      {!notifications ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-10 animate-pulse rounded border border-neutral-800/30 bg-neutral-900/20"
            />
          ))}
        </div>
      ) : notifications.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800/60 p-6 text-center">
          <p className="font-mono text-xs text-neutral-600">
            no activity yet
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {notifications.map((n) => (
            <div
              key={n._id}
              className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-neutral-900/40 ${
                n.read ? "opacity-50" : ""
              }`}
            >
              <span className="mt-0.5 font-mono text-[10px] text-neutral-600">
                {typeIcons[n.type] || "·"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-neutral-300">
                    {n.title}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-neutral-700">
                    {new Date(n.createdAt).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </span>
                </div>
                {n.body && (
                  <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-neutral-600">
                    {n.body}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Search ──────────────────────────────────────────────────────

function Search() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [totalFound, setTotalFound] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearched(true);
    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await resp.json();
      setResults(data.hits || []);
      setTotalFound(data.totalFound || 0);
    } catch {
      setResults([]);
      setTotalFound(0);
    }
    setSearching(false);
  }, [query]);

  const collectionColors: Record<string, string> = {
    vault_notes: "text-blue-400 bg-blue-500/10",
    memory_observations: "text-purple-400 bg-purple-500/10",
    blog_posts: "text-claw bg-claw/10",
    system_log: "text-amber-400 bg-amber-500/10",
    discoveries: "text-emerald-400 bg-emerald-500/10",
    voice_transcripts: "text-cyan-400 bg-cyan-500/10",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600">
          Search
        </h2>
        {searched && !searching && (
          <span className="font-mono text-[10px] text-neutral-700">
            {totalFound} results
          </span>
        )}
        <div className="h-px flex-1 bg-neutral-800/40" />
      </div>

      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="vault, memory, blog, system log..."
          className="w-full rounded-lg border border-neutral-800/60 bg-neutral-950 px-4 py-3 pl-8 font-mono text-sm text-neutral-200 placeholder:text-neutral-700 transition-colors focus:border-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-800"
        />
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-neutral-700">
          /
        </span>
        {searching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-neutral-700 border-t-claw" />
          </span>
        )}
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-1.5 scrollbar-thin max-h-[60vh] overflow-y-auto">
          {results.map((hit: any, i: number) => (
            <div
              key={i}
              className="group rounded-lg border border-neutral-800/30 bg-neutral-900/10 p-3 transition-colors hover:border-neutral-700/50 hover:bg-neutral-900/30"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
                    collectionColors[hit.collection] ||
                    "text-neutral-400 bg-neutral-800/50"
                  }`}
                >
                  {hit.collection.replace("_", " ")}
                </span>
                <span className="truncate font-mono text-xs text-neutral-300 group-hover:text-neutral-100">
                  {hit.title}
                </span>
              </div>
              {hit.snippet && (
                <p
                  className="mt-1.5 font-mono text-[11px] leading-relaxed text-neutral-500 [&_mark]:bg-transparent [&_mark]:text-claw [&_mark]:font-medium"
                  dangerouslySetInnerHTML={{ __html: hit.snippet }}
                />
              )}
              {hit.path && (
                <p className="mt-1 font-mono text-[10px] text-neutral-700">
                  {hit.path}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {searched && !searching && results.length === 0 && (
        <p className="py-4 text-center font-mono text-xs text-neutral-600">
          no matches
        </p>
      )}
    </div>
  );
}

// ── Stats bar ───────────────────────────────────────────────────

function StatsBar() {
  return (
    <div className="flex items-center gap-6 border-b border-neutral-800/40 pb-4 font-mono text-[10px] text-neutral-600">
      <div className="flex items-center gap-1.5">
        <span className="text-neutral-500">collections</span>
        <span className="text-neutral-400">6</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-neutral-500">documents</span>
        <span className="text-neutral-400">2,692</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-neutral-500">functions</span>
        <span className="text-neutral-400">66</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-neutral-500">backend</span>
        <span className="text-claw/60">typesense</span>
      </div>
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <StatsBar />
      <Search />
      <div className="grid gap-8 lg:grid-cols-2">
        <SystemHealth />
        <NotificationFeed />
      </div>
    </div>
  );
}
