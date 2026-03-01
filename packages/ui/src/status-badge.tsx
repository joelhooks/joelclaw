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
  healthy: { dot: "bg-emerald-400", glow: "shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]" },
  degraded: { dot: "bg-amber-400", glow: "shadow-[0_0_6px_2px_rgba(251,191,36,0.5)]" },
  down: { dot: "bg-rose-400", glow: "shadow-[0_0_6px_2px_rgba(251,113,133,0.5)]" },
  unknown: { dot: "bg-neutral-500", glow: "shadow-[0_0_4px_1px_rgba(163,163,163,0.3)]" },
  debug: { dot: "bg-neutral-500", glow: "shadow-[0_0_4px_1px_rgba(163,163,163,0.3)]" },
  info: { dot: "bg-sky-400", glow: "shadow-[0_0_6px_2px_rgba(56,189,248,0.5)]" },
  warn: { dot: "bg-amber-400", glow: "shadow-[0_0_6px_2px_rgba(251,191,36,0.5)]" },
  error: { dot: "bg-rose-400", glow: "shadow-[0_0_6px_2px_rgba(251,113,133,0.5)]" },
  fatal: { dot: "bg-rose-400", glow: "shadow-[0_0_6px_2px_rgba(251,113,133,0.5)]" },
};

const STATUS_LED_SIZES: Record<StatusLedSize, string> = {
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
  lg: "h-3 w-3",
};

const STATUS_PULSE_COLORS: Record<StatusKind, { bg: string; shadow: string }> = {
  healthy: { bg: "#10b981", shadow: "rgba(16,185,129,0.5)" },
  degraded: { bg: "#f59e0b", shadow: "rgba(245,158,11,0.5)" },
  down: { bg: "#f43f5e", shadow: "rgba(244,63,94,0.5)" },
  unknown: { bg: "#737373", shadow: "rgba(115,115,115,0.5)" },
  debug: { bg: "#737373", shadow: "rgba(115,115,115,0.5)" },
  info: { bg: "#0ea5e9", shadow: "rgba(14,165,233,0.5)" },
  warn: { bg: "#f59e0b", shadow: "rgba(245,158,11,0.5)" },
  error: { bg: "#f97316", shadow: "rgba(249,115,22,0.5)" },
  fatal: { bg: "#f43f5e", shadow: "rgba(244,63,94,0.5)" },
};

const PULSE_OFFSET_WINDOW_MS = 1400;

function hashPulseSeed(seed: string | number): number {
  if (typeof seed === "number") {
    return Math.abs(seed);
  }

  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }

  return Math.abs(hash);
}

function getPulseDelayMs(seed: string | number): string {
  const offset = hashPulseSeed(seed);
  return `${offset % PULSE_OFFSET_WINDOW_MS}ms`;
}

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
  pulseSeed,
  pulseOffsetMs,
}: {
  status: StatusKind | string;
  label?: string;
  className?: string;
  pulse?: boolean;
  pulseSeed?: string | number;
  pulseOffsetMs?: number;
}): JSX.Element {
  const kind = normalizeStatusKind(typeof status === "string" ? status : String(status));
  const style = STATUS_STYLES[kind];
  const text = label ?? kind;
  const pulseDelay = pulse
    ? pulseOffsetMs != null
      ? `${pulseOffsetMs}ms`
      : getPulseDelayMs(pulseSeed ?? text)
    : undefined;

  return (
    <span
      className={`inline-flex min-h-6 items-center gap-2 rounded-full px-2 py-1 text-[10px] font-mono uppercase tracking-wide ${style.bg} ${style.text} ${className ?? ""}`}
    >
      <span className="relative inline-flex h-2 w-2">
        {pulse ? (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${style.dot} opacity-40`}
            style={{ animationDelay: pulseDelay }}
          />
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
  pulseSeed,
  pulseOffsetMs,
  label,
}: {
  status: StatusKind | string;
  size?: StatusLedSize;
  className?: string;
  pulse?: boolean;
  pulseSeed?: string | number;
  pulseOffsetMs?: number;
  label?: string;
}): JSX.Element {
  const kind = normalizeStatusKind(typeof status === "string" ? status : String(status));
  const style = STATUS_LED_STYLES[kind];
  const sizeClass = STATUS_LED_SIZES[size];
  const shouldPulse = pulse ?? kind === "healthy";
  const pulseDelay = shouldPulse ? (pulseOffsetMs != null ? `${pulseOffsetMs}ms` : getPulseDelayMs(pulseSeed ?? label ?? status)) : undefined;

  return (
    <span className={`relative inline-flex shrink-0 align-middle ${sizeClass} ${className ?? ""}`} aria-hidden="true">
      {shouldPulse ? (
        <span
          className={`absolute inset-0 animate-ping rounded-full ${style.dot} opacity-35`}
          style={{ animationDelay: pulseDelay }}
        />
      ) : null}
      <span className={`relative inline-flex rounded-full ${sizeClass} ${style.dot} ${style.glow}`} />
    </span>
  );
}

export function StatusPulseDot({
  status,
  size = "md",
  className,
  pulse,
  label,
  pulseSeed,
  pulseOffsetMs,
}: {
  status: StatusKind | string;
  size?: StatusLedSize;
  className?: string;
  pulse?: boolean;
  label?: string;
  pulseSeed?: string | number;
  pulseOffsetMs?: number;
}): JSX.Element {
  const kind = normalizeStatusKind(typeof status === "string" ? status : String(status));
  const colors = STATUS_PULSE_COLORS[kind];
  const sizeClass = STATUS_LED_SIZES[size];
  const statusLabel = label ?? kind;
  const shouldPulse = pulse ?? kind === "healthy";
  const pulseDelay = shouldPulse
    ? pulseOffsetMs != null
      ? `${pulseOffsetMs}ms`
      : getPulseDelayMs(pulseSeed ?? statusLabel)
    : undefined;

  return (
    <span
      className={`relative inline-flex shrink-0 ${sizeClass} ${className ?? ""}`}
      role="img"
      aria-label={statusLabel}
      title={statusLabel}
    >
      {shouldPulse ? (
        <span
          className="absolute inset-0 animate-ping rounded-full opacity-75"
          style={{ backgroundColor: colors.bg, animationDelay: pulseDelay }}
        />
      ) : null}
      <span
        className={`relative inline-flex rounded-full ${sizeClass}`}
        style={{ backgroundColor: colors.bg, boxShadow: `0 1px 2px 0 ${colors.shadow}` }}
      />
    </span>
  );
}
