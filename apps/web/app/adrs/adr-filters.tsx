"use client";

import { useCallback, useMemo, useState } from "react";
import type { AdrMeta } from "@/lib/adrs";
import { BAND_CONFIG, BAND_ORDER, type PriorityBand } from "./band-config";
import { STATUS_CONFIG } from "./status-config";

// ─── Sort definitions ────────────────────────────────────────────────

export type SortKey = "rubric" | "number-desc" | "number-asc" | "date";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "rubric", label: "Priority" },
  { key: "number-desc", label: "Newest" },
  { key: "number-asc", label: "Oldest" },
  { key: "date", label: "Date" },
];

const BAND_RANK: Record<string, number> = {
  "do-now": 0,
  next: 1,
  "de-risk": 2,
  park: 3,
};

function rubricSort(a: AdrMeta, b: AdrMeta): number {
  const aHas = a.priority != null;
  const bHas = b.priority != null;

  // ADRs with rubric sort above those without
  if (aHas !== bHas) return aHas ? -1 : 1;

  if (aHas && bHas) {
    const aBand = BAND_RANK[a.priority!.band] ?? 99;
    const bBand = BAND_RANK[b.priority!.band] ?? 99;
    if (aBand !== bBand) return aBand - bBand;

    // Within same band: higher score first
    if (a.priority!.score !== b.priority!.score) return b.priority!.score - a.priority!.score;

    // Same score: higher need first
    if (a.priority!.need !== b.priority!.need) return b.priority!.need - a.priority!.need;
  }

  // Fall back to ADR number ascending
  const aNum = Number.parseInt(a.number, 10) || 0;
  const bNum = Number.parseInt(b.number, 10) || 0;
  return aNum - bNum;
}

function numberDescSort(a: AdrMeta, b: AdrMeta): number {
  return (Number.parseInt(b.number, 10) || 0) - (Number.parseInt(a.number, 10) || 0);
}

function numberAscSort(a: AdrMeta, b: AdrMeta): number {
  return (Number.parseInt(a.number, 10) || 0) - (Number.parseInt(b.number, 10) || 0);
}

function dateSort(a: AdrMeta, b: AdrMeta): number {
  return (b.date || "").localeCompare(a.date || "");
}

const SORT_FNS: Record<SortKey, (a: AdrMeta, b: AdrMeta) => number> = {
  rubric: rubricSort,
  "number-desc": numberDescSort,
  "number-asc": numberAscSort,
  date: dateSort,
};

// ─── Hook ────────────────────────────────────────────────────────────

export function useAdrFilters(allStatuses: string[], allBands: PriorityBand[]) {
  const [activeStatuses, setActiveStatuses] = useState<Set<string>>(() => new Set(allStatuses));
  const [activeBands, setActiveBands] = useState<Set<string>>(() => new Set([...allBands, "__none__"]));
  const [sortKey, setSortKey] = useState<SortKey>("rubric");

  const toggleStatus = useCallback((status: string) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        if (next.size <= 1) return prev;
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }, []);

  const toggleBand = useCallback((band: string) => {
    setActiveBands((prev) => {
      const next = new Set(prev);
      if (next.has(band)) {
        if (next.size <= 1) return prev;
        next.delete(band);
      } else {
        next.add(band);
      }
      return next;
    });
  }, []);

  return { activeStatuses, activeBands, sortKey, toggleStatus, toggleBand, setSortKey };
}

// ─── Filter bar components ───────────────────────────────────────────

export function StatusFilterBar({
  counts,
  allStatuses,
  active,
  onToggle,
}: {
  counts: Record<string, number>;
  allStatuses: string[];
  active: Set<string>;
  onToggle: (status: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
      {allStatuses.map((status) => {
        const isActive = active.has(status);
        const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.proposed!;
        const count = counts[status] ?? 0;

        return (
          <button
            key={status}
            onClick={() => onToggle(status)}
            type="button"
            aria-pressed={isActive}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all cursor-pointer ${
              isActive
                ? `${cfg.color} ${cfg.bg} ${cfg.border} ${cfg.glow}`
                : "text-neutral-600 border-neutral-800/50 opacity-40"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-current" : "bg-neutral-700"} border ${cfg.border}`}
            />
            <span className="tabular-nums">{count}</span>
            <span>{status}</span>
          </button>
        );
      })}
    </div>
  );
}

export function BandFilterBar({
  bandCounts,
  activeBands,
  onToggle,
  noPriorityCount,
}: {
  bandCounts: Record<string, number>;
  activeBands: Set<string>;
  onToggle: (band: string) => void;
  noPriorityCount: number;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by priority band">
      {BAND_ORDER.map((band) => {
        const isActive = activeBands.has(band);
        const cfg = BAND_CONFIG[band];
        const count = bandCounts[band] ?? 0;
        if (count === 0) return null;

        return (
          <button
            key={band}
            onClick={() => onToggle(band)}
            type="button"
            aria-pressed={isActive}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all cursor-pointer ${
              isActive
                ? `${cfg.color} ${cfg.bg} ${cfg.border} ${cfg.glow}`
                : "text-neutral-600 border-neutral-800/50 opacity-40"
            }`}
          >
            <span className="tabular-nums">{count}</span>
            <span>{cfg.label}</span>
          </button>
        );
      })}
      {noPriorityCount > 0 && (
        <button
          onClick={() => onToggle("__none__")}
          type="button"
          aria-pressed={activeBands.has("__none__")}
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all cursor-pointer ${
            activeBands.has("__none__")
              ? "text-neutral-500 bg-neutral-900/30 border-neutral-700/40"
              : "text-neutral-600 border-neutral-800/50 opacity-40"
          }`}
        >
          <span className="tabular-nums">{noPriorityCount}</span>
          <span>Unscored</span>
        </button>
      )}
    </div>
  );
}

export function SortControl({
  sortKey,
  onChange,
}: {
  sortKey: SortKey;
  onChange: (key: SortKey) => void;
}) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Sort order">
      {SORT_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          type="button"
          aria-pressed={sortKey === opt.key}
          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-all cursor-pointer ${
            sortKey === opt.key
              ? "text-white bg-neutral-800 border border-neutral-700"
              : "text-neutral-600 hover:text-neutral-400"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── Combined filter bar ─────────────────────────────────────────────

export function AdrFilterBar({
  counts,
  allStatuses,
  bandCounts,
  noPriorityCount,
  filters,
}: {
  counts: Record<string, number>;
  allStatuses: string[];
  bandCounts: Record<string, number>;
  noPriorityCount: number;
  filters: ReturnType<typeof useAdrFilters>;
}) {
  const hasBands = Object.values(bandCounts).some((c) => c > 0);

  return (
    <div className="mt-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusFilterBar
          counts={counts}
          allStatuses={allStatuses}
          active={filters.activeStatuses}
          onToggle={filters.toggleStatus}
        />
        <SortControl sortKey={filters.sortKey} onChange={filters.setSortKey} />
      </div>
      {hasBands && (
        <BandFilterBar
          bandCounts={bandCounts}
          activeBands={filters.activeBands}
          onToggle={filters.toggleBand}
          noPriorityCount={noPriorityCount}
        />
      )}
    </div>
  );
}

// ─── Apply filters + sort ────────────────────────────────────────────

export function filterAndSortAdrs(
  adrs: AdrMeta[],
  activeStatuses: Set<string>,
  activeBands: Set<string>,
  sortKey: SortKey,
): AdrMeta[] {
  return adrs
    .filter((adr) => {
      if (!activeStatuses.has(adr.status)) return false;
      const band = adr.priority?.band ?? "__none__";
      if (!activeBands.has(band)) return false;
      return true;
    })
    .sort(SORT_FNS[sortKey]);
}
