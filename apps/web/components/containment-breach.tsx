"use client";

import { ShieldAlert } from "lucide-react";

export function ContainmentBreach() {
  return (
    <div className="flex items-center gap-3 my-6">
      <div className="h-px flex-1 bg-orange-500/30" />
      <span className="flex items-center gap-2 text-orange-500 font-mono text-xs tracking-[0.2em] uppercase whitespace-nowrap">
        <ShieldAlert className="h-4 w-4" />
        containment breach
        <ShieldAlert className="h-4 w-4" />
      </span>
      <div className="h-px flex-1 bg-orange-500/30" />
    </div>
  );
}
