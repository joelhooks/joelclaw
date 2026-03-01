/**
 * Tailwind v4 safelist — classes used in dynamic JS maps (@repo/ui status-badge)
 * that the scanner can't extract from runtime string concatenation.
 *
 * This file is referenced by @source in globals.css.
 * DO NOT DELETE — removing this breaks StatusPulseDot, StatusLed, StatusBadge.
 */

// prettier-ignore
export const _safelist = [
  // animate
  "animate-ping", "animate-pulse",
  // status dot colors
  "bg-emerald-400", "bg-emerald-500",
  "bg-sky-400", "bg-sky-500",
  "bg-amber-400", "bg-amber-500",
  "bg-rose-400", "bg-rose-500",
  "bg-orange-400", "bg-orange-500",
  "bg-neutral-500",
  // status glow shadows
  "shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]",
  "shadow-[0_0_6px_2px_rgba(56,189,248,0.5)]",
  "shadow-[0_0_6px_2px_rgba(251,191,36,0.5)]",
  "shadow-[0_0_6px_2px_rgba(251,113,133,0.5)]",
  "shadow-[0_0_4px_1px_rgba(163,163,163,0.3)]",
  // status pulse shadows
  "shadow-emerald-500/50", "shadow-sky-500/50",
  "shadow-amber-500/50", "shadow-rose-500/50",
  "shadow-orange-500/50", "shadow-neutral-500/50",
];
