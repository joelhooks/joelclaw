"use client";
import type { JSX } from "react";

export function SearchBar({
  value,
  onChange,
  onSubmit,
  placeholder = "search...",
  loading,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  loading?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <div className={`relative ${className ?? ""}`}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onSubmit ? (e) => e.key === "Enter" && onSubmit() : undefined}
        placeholder={placeholder}
        className="w-full rounded-lg border border-neutral-800/60 bg-neutral-950 px-4 py-3 pl-8 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 transition-colors focus:border-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-800"
      />
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-neutral-700">
        /
      </span>
      {loading && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-neutral-700 border-t-claw" />
        </span>
      )}
    </div>
  );
}
