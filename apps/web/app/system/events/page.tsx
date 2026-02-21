"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { EventTimeline, type TimelineEvent } from "@repo/ui/event-timeline";
import { FilterChips } from "@repo/ui/filter-chips";
import { api } from "../../../convex/_generated/api";
import { authClient } from "../../../lib/auth-client";

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

type FacetCounts = {
  field_name?: string;
  counts?: Array<{ value?: string; count?: number }>;
};

const LEVEL_OPTIONS = [
  { value: "debug" },
  { value: "info" },
  { value: "warn" },
  { value: "error" },
  { value: "fatal" },
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

export default function SystemEventsPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const isOwner = useQuery(api.auth.isOwner);

  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<string | undefined>();
  const [source, setSource] = useState<string | undefined>();
  const [events, setEvents] = useState<OtelHit[]>([]);
  const [facets, setFacets] = useState<FacetCounts[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const mode = query.trim().length > 0 ? "search" : "list";
    const params = new URLSearchParams({
      mode,
      limit: "80",
      page: "1",
      hours: "72",
    });
    if (query.trim()) params.set("q", query.trim());
    if (level) params.set("level", level);
    if (source) params.set("source", source);

    const response = await fetch(`/api/otel?${params.toString()}`);
    const json = await response.json().catch(() => null);
    if (response.ok && json) {
      setEvents(Array.isArray(json.hits) ? (json.hits as OtelHit[]) : []);
      setFacets(Array.isArray(json.facets) ? (json.facets as FacetCounts[]) : []);
    } else {
      setEvents([]);
      setFacets([]);
    }
    setLoading(false);
  }, [level, query, source]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      void load();
    }, 180);
    return () => clearTimeout(timeout);
  }, [load]);

  const sourceOptions = useMemo(() => {
    const sourceFacet = facets.find((facet) => facet.field_name === "source");
    return (sourceFacet?.counts ?? [])
      .filter((item) => typeof item.value === "string")
      .slice(0, 12)
      .map((item) => ({
        value: item.value as string,
        count: typeof item.count === "number" ? item.count : undefined,
      }));
  }, [facets]);

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
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-100">Otel Event Explorer</h1>
        <p className="font-mono text-xs text-neutral-500">
          Full-text search over <code>otel_events</code> with source and level filters.
        </p>
      </header>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="search action, error, component, metadata..."
        className="w-full rounded-lg border border-neutral-700/50 bg-neutral-950 px-4 py-3 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
      />

      <div className="space-y-2">
        <p className="font-pixel text-[11px] uppercase tracking-[0.14em] text-neutral-500">level</p>
        <FilterChips options={LEVEL_OPTIONS} selected={level} onSelect={setLevel} />
      </div>

      <div className="space-y-2">
        <p className="font-pixel text-[11px] uppercase tracking-[0.14em] text-neutral-500">source</p>
        <FilterChips options={sourceOptions} selected={source} onSelect={setSource} />
      </div>

      <EventTimeline
        events={timeline}
        emptyLabel={loading ? "loading events..." : "no events match current filters"}
      />
    </div>
  );
}

