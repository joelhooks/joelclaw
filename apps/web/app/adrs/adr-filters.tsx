"use client";

import { useQueryState, parseAsArrayOf, parseAsString } from "nuqs";
import type { AdrMeta } from "../../lib/adrs";

const STATUS_CONFIG: Record<
  string,
  { color: string; bg: string; border: string; glow: string }
> = {
  accepted: {
    color: "text-green-400",
    bg: "bg-green-950/40",
    border: "border-green-800/50",
    glow: "shadow-[0_0_8px_rgba(74,222,128,0.25)]",
  },
  proposed: {
    color: "text-yellow-400",
    bg: "bg-yellow-950/30",
    border: "border-yellow-800/50",
    glow: "shadow-[0_0_8px_rgba(250,204,21,0.25)]",
  },
  superseded: {
    color: "text-neutral-500",
    bg: "bg-neutral-900/40",
    border: "border-neutral-700/50",
    glow: "shadow-[0_0_8px_rgba(163,163,163,0.15)]",
  },
  implemented: {
    color: "text-claw",
    bg: "bg-pink-950/20",
    border: "border-pink-800/40",
    glow: "shadow-[0_0_8px_rgba(255,20,147,0.3)]",
  },
  deprecated: {
    color: "text-red-400",
    bg: "bg-red-950/30",
    border: "border-red-800/50",
    glow: "shadow-[0_0_8px_rgba(248,113,113,0.25)]",
  },
};

export function useAdrFilters() {
  return useQueryState(
    "status",
    parseAsArrayOf(parseAsString, ",").withOptions({ shallow: true })
  );
}

export function AdrFilterBar({
  counts,
  allStatuses,
}: {
  counts: Record<string, number>;
  allStatuses: string[];
}) {
  const [excluded, setExcluded] = useAdrFilters();

  // No URL param = all shown. URL param lists excluded statuses.
  const toggle = (status: string) => {
    const current = excluded ?? [];
    const isExcluded = current.includes(status);

    if (isExcluded) {
      // Re-include it
      const next = current.filter((s) => s !== status);
      setExcluded(next.length > 0 ? next : null);
    } else {
      // Exclude it — but don't allow excluding everything
      const next = [...current, status];
      if (next.length >= allStatuses.length) return;
      setExcluded(next);
    }
  };

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {allStatuses.map((status) => {
        const active = !(excluded ?? []).includes(status);
        const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.proposed!;
        const count = counts[status] ?? 0;

        return (
          <button
            key={status}
            onClick={() => toggle(status)}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-all cursor-pointer ${
              active
                ? `${cfg.color} ${cfg.bg} ${cfg.border} ${cfg.glow}`
                : "text-neutral-600 border-neutral-800/50 opacity-40"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${active ? "bg-current" : "bg-neutral-700"} border ${cfg.border}`}
            />
            <span className="tabular-nums">{count}</span>
            <span>{status}</span>
          </button>
        );
      })}
    </div>
  );
}

export function useFilteredAdrs(adrs: AdrMeta[]) {
  const [excluded] = useAdrFilters();
  if (!excluded || excluded.length === 0) return adrs;
  return adrs.filter((a) => !excluded.includes(a.status));
}
