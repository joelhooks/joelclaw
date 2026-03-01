"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { AdrMeta } from "@/lib/adrs";
import { formatDateStatic } from "@/lib/date";
import { AdrFilterBar, filterAndSortAdrs, useAdrFilters } from "./adr-filters";
import { BAND_CONFIG, BAND_ORDER, type PriorityBand } from "./band-config";
import { STATUS_CONFIG } from "./status-config";

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

function BandBadge({ band }: { band: PriorityBand }) {
  const cfg = BAND_CONFIG[band];
  return (
    <span
      className={`inline-flex text-[10px] font-medium uppercase tracking-widest border rounded-sm px-1.5 py-0.5 ${cfg.color} ${cfg.border} bg-transparent`}
    >
      {cfg.label}
    </span>
  );
}

function ScorePip({ score }: { score: number }) {
  return (
    <span className="text-[10px] font-mono text-neutral-500 tabular-nums">
      {score}
    </span>
  );
}

function formatDate(dateStr: string) {
  if (!dateStr) return "";
  return formatDateStatic(dateStr, { monthStyle: "short", includeYear: true });
}

function AdrRow({ adr }: { adr: AdrMeta }) {
  const isSuperseded = adr.status === "superseded";

  return (
    <li
      className={`group border-b border-neutral-800/50 last:border-0 ${isSuperseded ? "opacity-50" : ""}`}
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
            <div className="mt-2 flex items-center gap-2.5 flex-wrap">
              <StatusBadge status={adr.status} />
              {adr.priority && (
                <>
                  <BandBadge band={adr.priority.band} />
                  <ScorePip score={adr.priority.score} />
                </>
              )}
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
}: {
  adrs: AdrMeta[];
  counts: Record<string, number>;
  allStatuses: string[];
}) {
  const bandCounts = useMemo(() => {
    const bc: Record<string, number> = {};
    for (const adr of adrs) {
      if (adr.priority?.band) {
        bc[adr.priority.band] = (bc[adr.priority.band] ?? 0) + 1;
      }
    }
    return bc;
  }, [adrs]);

  const noPriorityCount = useMemo(
    () => adrs.filter((a) => !a.priority).length,
    [adrs],
  );

  const allBands = useMemo(
    () => BAND_ORDER.filter((b) => (bandCounts[b] ?? 0) > 0),
    [bandCounts],
  );

  const filters = useAdrFilters(allStatuses, allBands);

  const filtered = useMemo(
    () =>
      filterAndSortAdrs(
        adrs,
        filters.activeStatuses,
        filters.activeBands,
        filters.sortKey,
      ),
    [adrs, filters.activeStatuses, filters.activeBands, filters.sortKey],
  );

  return (
    <>
      <AdrFilterBar
        counts={counts}
        allStatuses={allStatuses}
        bandCounts={bandCounts}
        noPriorityCount={noPriorityCount}
        filters={filters}
      />
      <div className="mt-3 flex items-center justify-between text-[11px] text-neutral-600 px-1">
        <span>
          {filtered.length} of {adrs.length} ADRs
        </span>
      </div>
      <ul className="mt-2 border-t border-neutral-800/50">
        {filtered.map((adr) => (
          <AdrRow key={adr.slug} adr={adr} />
        ))}
        {filtered.length === 0 && (
          <li className="py-12 text-center text-sm text-neutral-600">
            No ADRs match current filters.
          </li>
        )}
      </ul>
    </>
  );
}
