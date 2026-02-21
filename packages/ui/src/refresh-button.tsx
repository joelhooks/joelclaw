import type { JSX } from "react";

export function RefreshButton({
  onClick,
  loading,
  label = "refresh",
  className,
}: {
  onClick: () => void;
  loading?: boolean;
  label?: string;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={`rounded border border-neutral-700/50 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-300 disabled:opacity-50 ${className ?? ""}`}
    >
      {loading ? (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border border-neutral-700 border-t-neutral-400" />
      ) : (
        label
      )}
    </button>
  );
}
