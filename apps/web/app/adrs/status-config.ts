export const STATUS_CONFIG: Record<
  string,
  { color: string; bg: string; border: string; glow: string }
> = {
  accepted: {
    color: "text-green-400",
    bg: "bg-green-950/40",
    border: "border-green-800/50",
    glow: "shadow-[0_0_8px_rgba(74,222,128,0.25)]",
  },
  proposed: {
    color: "text-yellow-400",
    bg: "bg-yellow-950/30",
    border: "border-yellow-800/50",
    glow: "shadow-[0_0_8px_rgba(250,204,21,0.25)]",
  },
  superseded: {
    color: "text-neutral-500",
    bg: "bg-neutral-900/40",
    border: "border-neutral-700/50",
    glow: "shadow-[0_0_8px_rgba(163,163,163,0.15)]",
  },
  shipped: {
    color: "text-claw",
    bg: "bg-pink-950/20",
    border: "border-pink-800/40",
    glow: "shadow-[0_0_8px_rgba(255,20,147,0.3)]",
  },
  implemented: {
    color: "text-claw",
    bg: "bg-pink-950/20",
    border: "border-pink-800/40",
    glow: "shadow-[0_0_8px_rgba(255,20,147,0.3)]",
  },
  deprecated: {
    color: "text-red-400",
    bg: "bg-red-950/30",
    border: "border-red-800/50",
    glow: "shadow-[0_0_8px_rgba(248,113,113,0.25)]",
  },
  deferred: {
    color: "text-blue-400",
    bg: "bg-blue-950/30",
    border: "border-blue-800/50",
    glow: "shadow-[0_0_8px_rgba(96,165,250,0.25)]",
  },
  in_progress: {
    color: "text-amber-400",
    bg: "bg-amber-950/30",
    border: "border-amber-800/50",
    glow: "shadow-[0_0_8px_rgba(251,191,36,0.25)]",
  },
  researching: {
    color: "text-purple-400",
    bg: "bg-purple-950/30",
    border: "border-purple-800/50",
    glow: "shadow-[0_0_8px_rgba(192,132,252,0.25)]",
  },
  withdrawn: {
    color: "text-neutral-500",
    bg: "bg-neutral-900/40",
    border: "border-neutral-700/50",
    glow: "shadow-[0_0_8px_rgba(163,163,163,0.15)]",
  },
  rejected: {
    color: "text-red-400",
    bg: "bg-red-950/30",
    border: "border-red-800/50",
    glow: "shadow-[0_0_8px_rgba(248,113,113,0.25)]",
  },
};
