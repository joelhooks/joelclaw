export const BAND_ORDER = ["do-now", "next", "de-risk", "park"] as const;
export type PriorityBand = (typeof BAND_ORDER)[number];

export const BAND_CONFIG: Record<
  PriorityBand,
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
