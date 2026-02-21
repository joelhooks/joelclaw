import type { JSX } from "react";
import { StatusBadge } from "./status-badge";

export type TimelineEvent = {
  id: string;
  timestamp: number | string;
  level?: string;
  source?: string;
  component?: string;
  action: string;
  message?: string;
  metadata?: Record<string, unknown>;
};

function formatTimestamp(value: number | string): string {
  if (typeof value === "number") {
    return new Date(value).toLocaleString();
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toLocaleString();
  }
  return String(value);
}

function metadataPreview(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata).slice(0, 3);
  if (entries.length === 0) return undefined;
  return entries
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
}

export function EventTimeline({
  events,
  emptyLabel = "no events",
  className,
}: {
  events: TimelineEvent[];
  emptyLabel?: string;
  className?: string;
}): JSX.Element {
  if (events.length === 0) {
    return (
      <div className={`rounded-lg border border-dashed border-neutral-800/60 p-6 text-center ${className ?? ""}`}>
        <p className="font-mono text-xs text-neutral-500">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <ol className={`space-y-2 ${className ?? ""}`}>
      {events.map((event) => {
        const preview = metadataPreview(event.metadata);
        return (
          <li
            key={event.id}
            className="rounded-xl border border-neutral-800/40 bg-neutral-900/30 px-3 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={event.level ?? "info"} label={event.level ?? "info"} />
              {event.source ? (
                <span className="rounded bg-neutral-800/70 px-2 py-1 font-mono text-[10px] text-neutral-300">
                  {event.source}
                </span>
              ) : null}
              {event.component ? (
                <span className="rounded bg-neutral-800/40 px-2 py-1 font-mono text-[10px] text-neutral-400">
                  {event.component}
                </span>
              ) : null}
              <span className="ml-auto text-[10px] font-mono text-neutral-500">
                {formatTimestamp(event.timestamp)}
              </span>
            </div>
            <p className="mt-2 font-mono text-sm text-neutral-200">{event.action}</p>
            {event.message ? (
              <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-neutral-400">{event.message}</p>
            ) : null}
            {preview ? (
              <p className="mt-1 line-clamp-2 font-mono text-[11px] text-neutral-600">{preview}</p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

