"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useState } from "react";

function StatusBadge({ status }: { status: string }) {
  const colors = {
    healthy: "bg-emerald-500/20 text-emerald-400",
    degraded: "bg-amber-500/20 text-amber-400",
    down: "bg-red-500/20 text-red-400",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status as keyof typeof colors] || colors.down}`}
    >
      {status}
    </span>
  );
}

function SystemHealth() {
  const status = useQuery(api.systemStatus.list);

  if (!status) {
    return (
      <div className="rounded-lg border border-neutral-800 p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-400 uppercase tracking-wider">
          System Health
        </h2>
        <p className="text-sm text-neutral-500">Loading...</p>
      </div>
    );
  }

  if (status.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-800 p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-400 uppercase tracking-wider">
          System Health
        </h2>
        <p className="text-sm text-neutral-500">
          No health data yet. Health checks will populate this on the next heartbeat.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-neutral-800 p-4">
      <h2 className="mb-3 text-sm font-semibold text-neutral-400 uppercase tracking-wider">
        System Health
      </h2>
      <div className="space-y-2">
        {status.map((s) => (
          <div
            key={s._id}
            className="flex items-center justify-between text-sm"
          >
            <span className="text-neutral-300">{s.component}</span>
            <div className="flex items-center gap-2">
              <StatusBadge status={s.status} />
              {s.detail && (
                <span className="text-xs text-neutral-500">{s.detail}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Notifications() {
  const notifications = useQuery(api.notifications.list, { limit: 10 });
  const unreadCount = useQuery(api.notifications.unreadCount);

  if (!notifications) {
    return (
      <div className="rounded-lg border border-neutral-800 p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-400 uppercase tracking-wider">
          Notifications
        </h2>
        <p className="text-sm text-neutral-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-neutral-800 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider">
          Notifications
        </h2>
        {unreadCount != null && unreadCount > 0 && (
          <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-400">
            {unreadCount} new
          </span>
        )}
      </div>
      {notifications.length === 0 ? (
        <p className="text-sm text-neutral-500">No notifications yet.</p>
      ) : (
        <div className="space-y-2">
          {notifications.map((n) => (
            <div
              key={n._id}
              className={`text-sm ${n.read ? "text-neutral-500" : "text-neutral-300"}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-600">
                  {new Date(n.createdAt).toLocaleTimeString()}
                </span>
                <span className="font-medium">{n.title}</span>
              </div>
              {n.body && (
                <p className="mt-0.5 text-xs text-neutral-500">{n.body}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SearchBox() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await resp.json();
      setResults(data.hits || []);
    } catch {
      setResults([]);
    }
    setSearching(false);
  };

  return (
    <div className="rounded-lg border border-neutral-800 p-4">
      <h2 className="mb-3 text-sm font-semibold text-neutral-400 uppercase tracking-wider">
        Search
      </h2>
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="Search vault, memory, blog, system log..."
          className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <button
          onClick={handleSearch}
          disabled={searching}
          className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-700 disabled:opacity-50"
        >
          {searching ? "..." : "Search"}
        </button>
      </div>
      {results.length > 0 && (
        <div className="mt-3 space-y-2">
          {results.map((hit: any, i: number) => (
            <div key={i} className="rounded border border-neutral-800 p-2">
              <div className="flex items-center gap-2">
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">
                  {hit.collection}
                </span>
                <span className="text-sm font-medium text-neutral-200">
                  {hit.title}
                </span>
              </div>
              {hit.snippet && (
                <p
                  className="mt-1 text-xs text-neutral-500"
                  dangerouslySetInnerHTML={{ __html: hit.snippet }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <SearchBox />
      <div className="grid gap-6 md:grid-cols-2">
        <SystemHealth />
        <Notifications />
      </div>
    </div>
  );
}
