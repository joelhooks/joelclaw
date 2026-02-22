"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { EventStream, type StreamEvent } from "@repo/ui/event-stream";
import { FilterBar } from "@repo/ui/filter-bar";
import { PageHeader } from "@repo/ui/page-header";
import { SearchBar } from "@repo/ui/search-bar";
import { api } from "@/convex/_generated/api";
import { authClient } from "@/lib/auth-client";

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

  const streamEvents: StreamEvent[] = entries.map((entry) => ({
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
    <div className="mx-auto max-w-[1800px] space-y-5">
      <PageHeader title="System Log" count={entries.length} />

      <SearchBar
        value={query}
        onChange={setQuery}
        placeholder="search syslog..."
      />

      {toolOptions.length > 0 ? (
        <FilterBar
          label="tool"
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
        <EventStream events={streamEvents} emptyLabel="no syslog entries found" maxHeight="70vh" />
      )}
    </div>
  );
}

