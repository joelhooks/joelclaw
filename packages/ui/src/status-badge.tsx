import type { JSX } from "react";

export type StatusKind =
  | "healthy"
  | "degraded"
  | "down"
  | "unknown"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";

const STATUS_STYLES: Record<StatusKind, { dot: string; text: string; bg: string }> = {
  healthy: { dot: "bg-emerald-400", text: "text-emerald-200", bg: "bg-emerald-500/10" },
  degraded: { dot: "bg-amber-400", text: "text-amber-200", bg: "bg-amber-500/10" },
  down: { dot: "bg-rose-400", text: "text-rose-200", bg: "bg-rose-500/10" },
  unknown: { dot: "bg-neutral-500", text: "text-neutral-300", bg: "bg-neutral-500/10" },
  debug: { dot: "bg-neutral-500", text: "text-neutral-300", bg: "bg-neutral-500/10" },
  info: { dot: "bg-sky-400", text: "text-sky-200", bg: "bg-sky-500/10" },
  warn: { dot: "bg-amber-400", text: "text-amber-200", bg: "bg-amber-500/10" },
  error: { dot: "bg-orange-400", text: "text-orange-200", bg: "bg-orange-500/10" },
  fatal: { dot: "bg-rose-400", text: "text-rose-200", bg: "bg-rose-500/15" },
};

export function normalizeStatusKind(value: string | undefined): StatusKind {
  if (!value) return "unknown";
  const normalized = value.toLowerCase();
  if (normalized in STATUS_STYLES) return normalized as StatusKind;
  if (normalized === "running" || normalized === "online") return "healthy";
  if (normalized === "offline") return "down";
  return "unknown";
}

export function StatusBadge({
  status,
  label,
  className,
  pulse = false,
}: {
  status: StatusKind | string;
  label?: string;
  className?: string;
  pulse?: boolean;
}): JSX.Element {
  const kind = normalizeStatusKind(typeof status === "string" ? status : String(status));
  const style = STATUS_STYLES[kind];
  const text = label ?? kind;

  return (
    <span
      className={`inline-flex min-h-6 items-center gap-2 rounded-full px-2 py-1 text-[10px] font-mono uppercase tracking-wide ${style.bg} ${style.text} ${className ?? ""}`}
    >
      <span className="relative inline-flex h-2 w-2">
        {pulse ? (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${style.dot} opacity-40`} />
        ) : null}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${style.dot}`} />
      </span>
      {text}
    </span>
  );
}

