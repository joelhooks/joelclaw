"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { Terminal } from "lucide-react";
import { EventTimeline, type TimelineEvent } from "@repo/ui/event-timeline";
import { FilterChips } from "@repo/ui/filter-chips";
import { api } from "../../convex/_generated/api";
import { authClient } from "../../lib/auth-client";

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
  const allEntries = (rawEntries ?? []).map((doc) => {
    const fields = (doc.fields ?? {}) as Record<string, unknown>;
    return {
      resourceId: doc.resourceId,
      action: String(fields.action ?? ""),
      tool: String(fields.tool ?? ""),
      detail: String(fields.detail ?? ""),
      reason: fields.reason ? String(fields.reason) : undefined,
      timestamp: Number(fields.timestamp ?? 0) * 1000,
    };
  });

  const entries = allEntries.filter((entry) => (toolFilter ? entry.tool === toolFilter : true));
  const toolOptions = useMemo(
    () =>
      [...new Set(allEntries.map((entry) => entry.tool))]
        .filter(Boolean)
        .sort()
        .slice(0, 12)
        .map((tool) => ({ value: tool })),
    [allEntries]
  );

  const timelineEvents: TimelineEvent[] = entries.map((entry) => ({
    id: entry.resourceId,
    timestamp: entry.timestamp,
    level: entry.action === "remove" ? "warn" : entry.action === "fix" ? "error" : "info",
    source: "slog",
    component: entry.tool,
    action: entry.action,
    message: entry.reason ? `${entry.detail}\n${entry.reason}` : entry.detail,
  }));

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
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6">
      <div className="flex items-center gap-3">
        <Terminal className="h-6 w-6 text-blue-400" />
        <h1 className="font-mono text-xl font-bold text-neutral-100">System Log</h1>
        <span className="font-mono text-xs text-neutral-500">{entries.length} entries</span>
      </div>

      <input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="search syslog..."
        className="w-full rounded-lg border border-neutral-700/50 bg-neutral-950 px-4 py-3 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
      />

      {toolOptions.length > 0 ? (
        <FilterChips
          options={toolOptions}
          selected={toolFilter}
          onSelect={(value) => setToolFilter(value)}
        />
      ) : null}

      {rawEntries === undefined ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, index) => (
            <div key={index} className="h-16 animate-pulse rounded-lg bg-neutral-800/30" />
          ))}
        </div>
      ) : (
        <EventTimeline events={timelineEvents} emptyLabel="no syslog entries found" />
      )}
    </div>
  );
}

