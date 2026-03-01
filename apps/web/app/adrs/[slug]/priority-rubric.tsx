import type { AdrPriority } from "@/lib/adrs";
import { formatDateStatic } from "@/lib/date";

const BAND_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; border: string; glow: string }
> = {
  "do-now": {
    label: "Do Now",
    color: "text-claw",
    bg: "bg-pink-950/20",
    border: "border-pink-800/40",
    glow: "shadow-[0_0_6px_rgba(255,20,147,0.2)]",
  },
  next: {
    label: "Next",
    color: "text-amber-400",
    bg: "bg-amber-950/20",
    border: "border-amber-800/40",
    glow: "shadow-[0_0_6px_rgba(251,191,36,0.15)]",
  },
  "de-risk": {
    label: "De-risk",
    color: "text-blue-400",
    bg: "bg-blue-950/20",
    border: "border-blue-800/40",
    glow: "shadow-[0_0_6px_rgba(96,165,250,0.15)]",
  },
  park: {
    label: "Park",
    color: "text-neutral-500",
    bg: "bg-neutral-900/30",
    border: "border-neutral-700/40",
    glow: "",
  },
};

function AxisBar({ label, value, max = 5 }: { label: string; value: number; max?: number }) {
  const pct = Math.min(value / max, 1) * 100;
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-neutral-500 text-right tabular-nums">
        {label}
      </span>
      <div className="flex-1 h-1.5 bg-neutral-800/60 rounded-full overflow-hidden">
        <div
          className="h-full bg-current rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-6 text-xs text-neutral-400 tabular-nums text-right">
        {value}
      </span>
    </div>
  );
}

export function PriorityRubric({ priority }: { priority: AdrPriority }) {
  const cfg = BAND_CONFIG[priority.band] ?? BAND_CONFIG.park!;

  return (
    <aside
      className={`mt-8 rounded-lg border ${cfg.border} ${cfg.bg} ${cfg.glow} p-5`}
      aria-label="Priority Rubric"
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          Priority Rubric
        </h2>
        <span
          className={`text-[11px] font-semibold uppercase tracking-wider rounded-sm px-2 py-0.5 border ${cfg.color} ${cfg.border}`}
        >
          {cfg.label}
        </span>
      </div>

      <div className={`space-y-2.5 ${cfg.color}`}>
        <AxisBar label="Need" value={priority.need} />
        <AxisBar label="Readiness" value={priority.readiness} />
        <AxisBar label="Confidence" value={priority.confidence} />
      </div>

      <div className="mt-4 flex items-baseline justify-between border-t border-neutral-800/40 pt-3">
        <span className="text-xs text-neutral-600">Composite score</span>
        <span className={`text-lg font-bold tabular-nums ${cfg.color}`}>
          {priority.score}
        </span>
      </div>

      {priority.rationale && (
        <p className="mt-3 text-xs text-neutral-500 leading-relaxed italic">
          {priority.rationale}
        </p>
      )}

      {priority.reviewed && (
        <p className="mt-2 text-[10px] text-neutral-600 tabular-nums">
          Reviewed{" "}
          {formatDateStatic(priority.reviewed, { monthStyle: "short", includeYear: true })}
        </p>
      )}
    </aside>
  );
}
