"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { EventTimeline, type TimelineEvent } from "@repo/ui/event-timeline";
import { FilterChips } from "@repo/ui/filter-chips";
import { MetricCard } from "@repo/ui/metric-card";
import { StatusBadge } from "@repo/ui/status-badge";
import { api } from "../../convex/_generated/api";
import { authClient } from "../../lib/auth-client";

type OtelStats = {
  total: number;
  errors: number;
  errorRate: number;
  windowHours: number;
  recent15m: {
    total: number;
    errors: number;
    errorRate: number;
  };
};

type OtelHit = {
  id: string;
  timestamp: number;
  level?: string;
  source?: string;
  component?: string;
  action: string;
  error?: string;
  metadata_json?: string;
};

const LEVEL_OPTIONS = [
  { value: "warn", label: "warn" },
  { value: "error", label: "error" },
  { value: "fatal", label: "fatal" },
];

function parseMetadata(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export default function SystemPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const isOwner = useQuery(api.auth.isOwner);

  const [stats, setStats] = useState<OtelStats | null>(null);
  const [events, setEvents] = useState<OtelHit[]>([]);
  const [level, setLevel] = useState<string | undefined>("error");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const eventLevel = level ? `&level=${encodeURIComponent(level)}` : "&level=warn,error,fatal";
    const [statsResp, eventsResp] = await Promise.all([
      fetch("/api/otel?mode=stats&hours=24"),
      fetch(`/api/otel?mode=list&limit=40${eventLevel}`),
    ]);

    const statsJson = await statsResp.json().catch(() => null);
    const eventsJson = await eventsResp.json().catch(() => null);
    if (statsResp.ok && statsJson) {
      setStats(statsJson as OtelStats);
    }
    if (eventsResp.ok && eventsJson && Array.isArray(eventsJson.hits)) {
      setEvents(eventsJson.hits as OtelHit[]);
    } else {
      setEvents([]);
    }
    setLoading(false);
  }, [level]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 20_000);
    return () => clearInterval(interval);
  }, [load]);

  const timeline = useMemo<TimelineEvent[]>(
    () =>
      events.map((event) => ({
        id: event.id,
        timestamp: event.timestamp,
        level: event.level,
        source: event.source,
        component: event.component,
        action: event.action,
        message: event.error,
        metadata: parseMetadata(event.metadata_json),
      })),
    [events]
  );

  const recentHealth = stats?.recent15m.errorRate ?? 0;
  const healthKind = recentHealth >= 0.3 ? "down" : recentHealth >= 0.15 ? "degraded" : "healthy";

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
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-neutral-100">System Observability</h1>
          <StatusBadge status={healthKind} label={healthKind} pulse={healthKind === "healthy"} />
        </div>
        <p className="font-mono text-xs text-neutral-500">
          Canonical event stream from <code>otel_events</code> (Typesense) with warn/error/fatal mirror in Convex.
        </p>
      </header>

      <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="24h events" value={stats?.total ?? 0} detail={loading ? "refreshing" : "hot path"} />
        <MetricCard label="24h errors" value={stats?.errors ?? 0} />
        <MetricCard
          label="24h error rate"
          value={`${Math.round((stats?.errorRate ?? 0) * 100)}%`}
          trend={(stats?.errorRate ?? 0) > 0.2 ? "up" : "flat"}
        />
        <MetricCard
          label="15m error rate"
          value={`${Math.round((stats?.recent15m.errorRate ?? 0) * 100)}%`}
          trend={recentHealth >= 0.15 ? "up" : "flat"}
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-pixel text-[11px] uppercase tracking-[0.14em] text-neutral-400">Recent Events</h2>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-neutral-700/50 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-300 hover:border-neutral-600"
          >
            refresh
          </button>
        </div>
        <FilterChips options={LEVEL_OPTIONS} selected={level} onSelect={setLevel} allLabel="all high-severity" />
        <EventTimeline events={timeline} emptyLabel={loading ? "loading events..." : "no events in window"} />
      </section>
    </div>
  );
}

