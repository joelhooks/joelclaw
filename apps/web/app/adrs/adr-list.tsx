"use client";

import Link from "next/link";
import type { AdrMeta } from "../../lib/adrs";
import { AdrFilterBar, useStatusFilter } from "./adr-filters";

const STATUS_CONFIG: Record<
  string,
  { color: string; bg: string; border: string }
> = {
  accepted: {
    color: "text-green-400",
    bg: "bg-green-950/40",
    border: "border-green-800/50",
  },
  proposed: {
    color: "text-yellow-400",
    bg: "bg-yellow-950/30",
    border: "border-yellow-800/50",
  },
  superseded: {
    color: "text-neutral-500",
    bg: "bg-neutral-900/40",
    border: "border-neutral-700/50",
  },
  implemented: {
    color: "text-claw",
    bg: "bg-pink-950/20",
    border: "border-pink-800/40",
  },
  deprecated: {
    color: "text-red-400",
    bg: "bg-red-950/30",
    border: "border-red-800/50",
  },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.proposed!;
  return (
    <span
      className={`inline-flex text-[10px] font-medium uppercase tracking-widest border rounded-sm px-2 py-0.5 ${cfg.color} ${cfg.bg} ${cfg.border}`}
    >
      {status}
    </span>
  );
}

function formatDate(dateStr: string) {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function AdrRow({ adr, hidden }: { adr: AdrMeta; hidden: boolean }) {
  const isSuperseded = adr.status === "superseded";

  return (
    <li
      className={`group border-b border-neutral-800/50 last:border-0 ${isSuperseded ? "opacity-50" : ""} ${hidden ? "hidden" : ""}`}
    >
      <Link href={`/adrs/${adr.slug}`} className="block py-4 sm:py-5">
        <div className="flex items-start gap-4">
          <span className="shrink-0 font-mono text-xs text-neutral-600 pt-1 tabular-nums">
            {adr.number.padStart(4, "0")}
          </span>
          <div className="min-w-0 flex-1">
            <h2
              className={`text-base font-medium tracking-tight group-hover:text-white transition-colors ${isSuperseded ? "line-through decoration-neutral-600" : ""}`}
            >
              {adr.title}
            </h2>
            {adr.description && (
              <p className="mt-1.5 text-sm text-neutral-500 leading-relaxed line-clamp-2">
                {adr.description}
              </p>
            )}
            <div className="mt-2 flex items-center gap-3">
              <StatusBadge status={adr.status} />
              <time className="text-xs text-neutral-600 tabular-nums">
                {formatDate(adr.date)}
              </time>
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}

export function AdrListWithFilters({
  adrs,
  counts,
  allStatuses,
  initialActive,
}: {
  adrs: AdrMeta[];
  counts: Record<string, number>;
  allStatuses: string[];
  initialActive: string[];
}) {
  const { active, toggle } = useStatusFilter(allStatuses, initialActive);

  return (
    <>
      <AdrFilterBar
        counts={counts}
        allStatuses={allStatuses}
        active={active}
        onToggle={toggle}
      />
      <ul className="mt-8 border-t border-neutral-800/50">
        {adrs.map((adr) => (
          <AdrRow
            key={adr.slug}
            adr={adr}
            hidden={!active.has(adr.status)}
          />
        ))}
      </ul>
    </>
  );
}
