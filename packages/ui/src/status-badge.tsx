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

export type StatusLedSize = "sm" | "md" | "lg";

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

const STATUS_LED_STYLES: Record<StatusKind, { dot: string; glow: string }> = {
  healthy: { dot: "bg-emerald-400", glow: "shadow-[0_0_8px_1px_rgba(52,211,153,0.55)]" },
  degraded: { dot: "bg-amber-400", glow: "shadow-[0_0_8px_1px_rgba(251,191,36,0.55)]" },
  down: { dot: "bg-rose-400", glow: "shadow-[0_0_8px_1px_rgba(251,113,133,0.55)]" },
  unknown: { dot: "bg-neutral-500", glow: "shadow-[0_0_6px_1px_rgba(163,163,163,0.35)]" },
  debug: { dot: "bg-neutral-500", glow: "shadow-[0_0_6px_1px_rgba(163,163,163,0.35)]" },
  info: { dot: "bg-sky-400", glow: "shadow-[0_0_8px_1px_rgba(56,189,248,0.55)]" },
  warn: { dot: "bg-amber-400", glow: "shadow-[0_0_8px_1px_rgba(251,191,36,0.55)]" },
  error: { dot: "bg-rose-400", glow: "shadow-[0_0_8px_1px_rgba(251,113,133,0.55)]" },
  fatal: { dot: "bg-rose-400", glow: "shadow-[0_0_8px_1px_rgba(251,113,133,0.55)]" },
};

const STATUS_LED_SIZES: Record<StatusLedSize, string> = {
  sm: "h-[6px] w-[6px]",
  md: "h-[8px] w-[8px]",
  lg: "h-[10px] w-[10px]",
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

export function StatusLed({
  status,
  size = "md",
  className,
  pulse,
}: {
  status: StatusKind | string;
  size?: StatusLedSize;
  className?: string;
  pulse?: boolean;
}): JSX.Element {
  const kind = normalizeStatusKind(typeof status === "string" ? status : String(status));
  const style = STATUS_LED_STYLES[kind];
  const sizeClass = STATUS_LED_SIZES[size];
  const shouldPulse = pulse ?? kind === "healthy";

  return (
    <span className={`relative inline-flex shrink-0 align-middle ${sizeClass} ${className ?? ""}`} aria-hidden="true">
      {shouldPulse ? (
        <span className={`absolute inset-0 animate-ping rounded-full ${style.dot} opacity-35`} />
      ) : null}
      <span className={`relative inline-flex rounded-full ${sizeClass} ${style.dot} ${style.glow}`} />
    </span>
  );
}
