"use client";

import { useQueryStates } from "nuqs";
import { adrSearchParams } from "./search-params";
import { STATUS_CONFIG } from "./status-config";

export function useStatusFilter(allStatuses: string[]) {
  const [{ status: included }, setParams] = useQueryStates(adrSearchParams, {
    shallow: true,
  });

  // null = all active (no URL param). Array = only those active.
  const active = new Set(included ?? allStatuses);

  const toggle = (status: string) => {
    const next = new Set(active);
    if (next.has(status)) {
      if (next.size <= 1) return; // Can't empty
      next.delete(status);
    } else {
      next.add(status);
    }
    // All active = clear param. Otherwise set included list.
    const arr = [...next];
    setParams({
      status: arr.length >= allStatuses.length ? null : arr,
    });
  };

  return { active, toggle };
}

export function AdrFilterBar({
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
    <div className="mt-4 flex flex-wrap gap-2">
      {allStatuses.map((status) => {
        const isActive = active.has(status);
        const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.proposed!;
        const count = counts[status] ?? 0;

        return (
          <button
            key={status}
            onClick={() => onToggle(status)}
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
