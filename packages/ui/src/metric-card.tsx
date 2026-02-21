import type { JSX } from "react";

export function MetricCard({
  label,
  value,
  detail,
  trend,
  className,
}: {
  label: string;
  value: string | number;
  detail?: string;
  trend?: "up" | "down" | "flat";
  className?: string;
}): JSX.Element {
  const trendGlyph = trend === "up" ? "▲" : trend === "down" ? "▼" : trend === "flat" ? "■" : null;
  const trendClass =
    trend === "up"
      ? "text-emerald-300"
      : trend === "down"
        ? "text-rose-300"
        : "text-neutral-400";

  return (
    <article
      className={`rounded-xl border border-neutral-800/70 bg-neutral-900/30 px-4 py-3 ${className ?? ""}`}
    >
      <p className="text-[10px] font-pixel uppercase tracking-[0.14em] text-neutral-500">{label}</p>
      <div className="mt-2 flex items-baseline gap-2">
        <p className="font-mono text-lg text-neutral-100">{value}</p>
        {trendGlyph ? <span className={`font-mono text-[10px] ${trendClass}`}>{trendGlyph}</span> : null}
      </div>
      {detail ? <p className="mt-1 text-[11px] font-mono text-neutral-500">{detail}</p> : null}
    </article>
  );
}

