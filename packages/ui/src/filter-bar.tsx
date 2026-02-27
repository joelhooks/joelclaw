"use client";
import type { JSX } from "react";
import type { FilterChipOption } from "./filter-chips";
import { FilterChips } from "./filter-chips";

/**
 * Labeled filter chips wrapper for consistent data page filtering.
 *
 * Usage:
 *   <FilterBar label="level" options={levelOptions} selected={level} onSelect={setLevel} />
 *   <FilterBar label="source" options={sourceOptions} selected={source} onSelect={setSource} allLabel="all sources" />
 */
export function FilterBar({
  label,
  options,
  selected,
  onSelect,
  allLabel,
  className,
}: {
  label: string;
  options: FilterChipOption[];
  selected?: string;
  onSelect: (value: string | undefined) => void;
  allLabel?: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      <p className="font-pixel text-[11px] uppercase tracking-[0.14em] text-neutral-500">
        {label}
      </p>
      <FilterChips
        options={options}
        selected={selected}
        onSelect={onSelect}
        allLabel={allLabel}
      />
    </div>
  );
}
