"use client";

import type { JSX } from "react";

export type FilterChipOption = {
  value: string;
  label?: string;
  count?: number;
};

export function FilterChips({
  options,
  selected,
  onSelect,
  allLabel = "all",
  className,
}: {
  options: FilterChipOption[];
  selected?: string;
  onSelect: (value: string | undefined) => void;
  allLabel?: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={`flex flex-wrap gap-1.5 ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => onSelect(undefined)}
        className={`min-h-8 rounded-full border px-3 py-1 text-[10px] font-mono uppercase tracking-wide transition-colors ${
          selected == null
            ? "border-neutral-600 bg-neutral-700/80 text-neutral-100"
            : "border-neutral-800/50 bg-neutral-900/40 text-neutral-500 hover:border-neutral-700/60 hover:text-neutral-300"
        }`}
      >
        {allLabel}
      </button>
      {options.map((option) => {
        const active = selected === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(active ? undefined : option.value)}
            className={`min-h-8 rounded-full border px-3 py-1 text-[10px] font-mono uppercase tracking-wide transition-colors ${
              active
                ? "border-neutral-600 bg-neutral-700/80 text-neutral-100"
                : "border-neutral-800/50 bg-neutral-900/40 text-neutral-500 hover:border-neutral-700/60 hover:text-neutral-300"
            }`}
          >
            {option.label ?? option.value}
            {typeof option.count === "number" ? ` ${option.count}` : ""}
          </button>
        );
      })}
    </div>
  );
}

