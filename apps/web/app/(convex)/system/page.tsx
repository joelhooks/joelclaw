"use client";

import { DataGrid } from "@repo/ui/data-grid";
import { EventStream, type StreamEvent } from "@repo/ui/event-stream";
import { FilterBar } from "@repo/ui/filter-bar";
import { MetricCard } from "@repo/ui/metric-card";
import { PageHeader } from "@repo/ui/page-header";
import { RefreshButton } from "@repo/ui/refresh-button";
import { StatusPulseDot } from "@repo/ui/status-badge";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { authClient } from "@/lib/auth-client";

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

  const streamEvents = useMemo<StreamEvent[]>(
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

  if (isPending) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-neutral-700 border-t-claw" />
      </div>
    );
  }
  if (!session?.user) {
    router.replace("/");
    return null;
  }

  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <PageHeader
        title="System Observability"
        subtitle="Canonical event stream from otel_events (Typesense) with warn/error/fatal mirror in Convex."
        badge={<StatusPulseDot status={healthKind} label={`System is ${healthKind}`} />}
        actions={<RefreshButton onClick={() => void load()} loading={loading} />}
      />

      <DataGrid columns="metrics">
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
      </DataGrid>

      <section className="space-y-3">
        <FilterBar label="severity" options={LEVEL_OPTIONS} selected={level} onSelect={setLevel} allLabel="all high-severity" />
        <EventStream events={streamEvents} emptyLabel={loading ? "loading events..." : "no events in window"} maxHeight="70vh" />
      </section>
    </div>
  );
}
