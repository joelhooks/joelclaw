"use client";

import { useState, useCallback } from "react";
import { STATUS_CONFIG } from "./status-config";

function writeUrl(active: Set<string>, allStatuses: string[]) {
  const url = new URL(window.location.href);
  if (active.size === allStatuses.length) {
    url.searchParams.delete("status");
  } else {
    url.searchParams.set("status", [...active].join(","));
  }
  window.history.replaceState(null, "", url.toString());
}

export function useStatusFilter(
  allStatuses: string[],
  initialActive: string[]
) {
  const [active, setActive] = useState<Set<string>>(
    () => new Set(initialActive)
  );

  const toggle = useCallback(
    (status: string) => {
      setActive((prev) => {
        const next = new Set(prev);
        if (next.has(status)) {
          if (next.size <= 1) return prev;
          next.delete(status);
        } else {
          next.add(status);
        }
        writeUrl(next, allStatuses);
        return next;
      });
    },
    [allStatuses]
  );

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
