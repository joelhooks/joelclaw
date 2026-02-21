import type { JSX } from "react";

/**
 * Metric display card with optional trend indicator.
 *
 * Sizes:
 *   "default" — compact, for metric grids (current behavior)
 *   "large"   — hero metrics with bigger type, more padding
 *
 * Usage:
 *   <MetricCard label="24h events" value={1234} />
 *   <MetricCard label="error rate" value="12%" trend="up" size="large" />
 */
export function MetricCard({
  label,
  value,
  detail,
  trend,
  size = "default",
  className,
}: {
  label: string;
  value: string | number;
  detail?: string;
  trend?: "up" | "down" | "flat";
  size?: "default" | "large";
  className?: string;
}): JSX.Element {
  const trendGlyph = trend === "up" ? "▲" : trend === "down" ? "▼" : trend === "flat" ? "■" : null;
  const trendClass =
    trend === "up"
      ? "text-emerald-300"
      : trend === "down"
        ? "text-rose-300"
        : "text-neutral-400";

  const isLarge = size === "large";

  return (
    <article
      className={`rounded-xl border border-neutral-800/70 bg-neutral-900/30 ${
        isLarge ? "px-5 py-4 sm:px-6 sm:py-5" : "px-4 py-3"
      } ${className ?? ""}`}
    >
      <p
        className={`font-pixel uppercase tracking-[0.14em] text-neutral-500 ${
          isLarge ? "text-[11px] sm:text-xs" : "text-[10px]"
        }`}
      >
        {label}
      </p>
      <div className={`flex items-baseline gap-2 ${isLarge ? "mt-3" : "mt-2"}`}>
        <p
          className={`font-mono text-neutral-100 ${
            isLarge ? "text-2xl sm:text-3xl" : "text-lg"
          }`}
        >
          {value}
        </p>
        {trendGlyph ? (
          <span className={`font-mono ${isLarge ? "text-xs" : "text-[10px]"} ${trendClass}`}>
            {trendGlyph}
          </span>
        ) : null}
      </div>
      {detail ? (
        <p
          className={`font-mono text-neutral-500 ${
            isLarge ? "mt-2 text-xs" : "mt-1 text-[11px]"
          }`}
        >
          {detail}
        </p>
      ) : null}
    </article>
  );
}
