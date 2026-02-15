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

export function useAdrFilters(allStatuses: string[]) {
  const [included, setIncluded] = useQueryState(
    "status",
    parseAsArrayOf(parseAsString, ",").withOptions({ shallow: true })
  );

  // null = all shown (default). Array = only those shown.
  const active = included ?? allStatuses;

  const toggle = (status: string) => {
    const isActive = active.includes(status);

    if (isActive) {
      // Turning off — show remaining active ones in URL
      const next = active.filter((s) => s !== status);
      if (next.length === 0) return; // Can't exclude everything
      setIncluded(next);
    } else {
      // Turning on — add it back
      const next = [...active, status];
      // If all are now active, clear the URL param
      if (next.length >= allStatuses.length) {
        setIncluded(null);
      } else {
        setIncluded(next);
      }
    }
  };

  return { active, toggle };
}

export function AdrFilterBar({
  counts,
  allStatuses,
}: {
  counts: Record<string, number>;
  allStatuses: string[];
}) {
  const { active, toggle } = useAdrFilters(allStatuses);

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {allStatuses.map((status) => {
        const isActive = active.includes(status);
        const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.proposed!;
        const count = counts[status] ?? 0;

        return (
          <button
            key={status}
            onClick={() => toggle(status)}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-all cursor-pointer ${
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

export function useFilteredAdrs(adrs: AdrMeta[], allStatuses: string[]) {
  const { active } = useAdrFilters(allStatuses);
  return adrs.filter((a) => active.includes(a.status));
}
