"use client";
import { useState } from "react";
import type { JSX } from "react";

/**
 * Dense, terminal-style event stream. Evolution of EventTimeline for
 * data-heavy pages — severity-colored left border, relative timestamps,
 * expandable metadata rows.
 *
 * Supports the same TimelineEvent type for drop-in compatibility.
 */

export type StreamEvent = {
  id: string;
  timestamp: number | string;
  level?: string;
  source?: string;
  component?: string;
  action: string;
  message?: string;
  metadata?: Record<string, unknown>;
};

const LEVEL_BORDER: Record<string, string> = {
  fatal: "border-l-rose-500",
  error: "border-l-orange-400",
  warn: "border-l-amber-400",
  info: "border-l-sky-400/50",
  debug: "border-l-neutral-700",
};

const LEVEL_TEXT: Record<string, string> = {
  fatal: "text-rose-400",
  error: "text-orange-400",
  warn: "text-amber-400",
  info: "text-sky-400/70",
  debug: "text-neutral-600",
};

function relativeTime(value: number | string): string {
  const now = Date.now();
  const ts = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(ts)) return String(value);

  const diff = now - ts;
  if (diff < 0) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function absoluteTime(value: number | string): string {
  const ts = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(ts)) return String(value);
  return new Date(ts).toLocaleString();
}

function formatMetadata(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .map(([key, val]) => `${key}=${typeof val === "string" ? val : JSON.stringify(val)}`)
    .join("  ");
}

function EventRow({ event }: { event: StreamEvent }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const level = event.level ?? "info";
  const borderClass = LEVEL_BORDER[level] ?? "border-l-neutral-800";
  const levelClass = LEVEL_TEXT[level] ?? "text-neutral-500";
  const hasMeta = event.metadata && Object.keys(event.metadata).length > 0;

  return (
    <li
      className={`border-l-2 ${borderClass} bg-neutral-900/20 transition-colors hover:bg-neutral-900/40`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 text-left"
      >
        {/* Primary row */}
        <div className="flex items-baseline gap-2 min-w-0">
          <span className={`shrink-0 font-mono text-[10px] uppercase w-[3.5ch] ${levelClass}`}>
            {level.slice(0, 4)}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-neutral-600 w-[6ch] text-right tabular-nums" title={absoluteTime(event.timestamp)}>
            {relativeTime(event.timestamp)}
          </span>
          {event.source ? (
            <span className="shrink-0 font-mono text-[10px] text-neutral-400 truncate max-w-[10ch]">
              {event.source}
            </span>
          ) : null}
          {event.component ? (
            <span className="shrink-0 font-mono text-[10px] text-neutral-500 truncate max-w-[12ch]">
              {event.component}
            </span>
          ) : null}
          <span className="font-mono text-xs text-neutral-200 truncate">
            {event.action}
          </span>
          {hasMeta ? (
            <span className="shrink-0 font-mono text-[9px] text-neutral-700 ml-auto">
              {expanded ? "▼" : "▶"}
            </span>
          ) : null}
        </div>

        {/* Message line (always visible if present) */}
        {event.message ? (
          <p className={`mt-0.5 font-mono text-[11px] text-neutral-500 ${expanded ? "" : "line-clamp-1"} ml-[9.5ch]`}>
            {event.message}
          </p>
        ) : null}
      </button>

      {/* Expanded metadata */}
      {expanded && hasMeta ? (
        <div className="border-t border-neutral-800/40 px-3 py-2 ml-[9.5ch]">
          <pre className="font-mono text-[10px] text-neutral-600 whitespace-pre-wrap break-all leading-relaxed">
            {formatMetadata(event.metadata!)}
          </pre>
        </div>
      ) : null}
    </li>
  );
}

export function EventStream({
  events,
  emptyLabel = "no events",
  maxHeight,
  className,
}: {
  events: StreamEvent[];
  emptyLabel?: string;
  maxHeight?: string;
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
    <ol
      className={`divide-y divide-neutral-800/30 rounded-lg border border-neutral-800/40 overflow-hidden ${className ?? ""}`}
      style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}
    >
      {events.map((event) => (
        <EventRow key={event.id} event={event} />
      ))}
    </ol>
  );
}
