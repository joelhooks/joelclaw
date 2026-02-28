"use client";

import type { StatusKind } from "@repo/ui/status-badge";
import { StatusPulseDot } from "@repo/ui/status-badge";
import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";

interface FeedbackStatusProps {
  resourceId: string;
}

type Phase = "idle" | "pending" | "processing" | "applied" | "failed";

const PHASE_CONFIG: Record<
  Exclude<Phase, "idle">,
  { status: StatusKind; label: string; pulse: boolean }
> = {
  pending: { status: "info", label: "queued", pulse: true },
  processing: { status: "info", label: "applying feedback…", pulse: true },
  applied: { status: "healthy", label: "✓ applied", pulse: false },
  failed: { status: "error", label: "revision failed", pulse: false },
};

function derivePhase(
  items: { status: string; resolvedAt?: number }[] | undefined,
): Phase {
  if (!items || items.length === 0) return "idle";

  const hasProcessing = items.some((i) => i.status === "processing");
  if (hasProcessing) return "processing";

  const hasPending = items.some((i) => i.status === "pending");
  if (hasPending) return "pending";

  const hasFailed = items.some((i) => i.status === "failed");
  if (hasFailed) return "failed";

  const now = Date.now();
  const recentApplied = items.some(
    (i) => i.status === "applied" && i.resolvedAt && now - i.resolvedAt < 5000,
  );
  if (recentApplied) return "applied";

  return "idle";
}

export function FeedbackStatus({ resourceId }: FeedbackStatusProps) {
  const feedbackItems = useQuery(api.feedback.listByResource, { resourceId });
  const phase = derivePhase(feedbackItems);

  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    if (phase === "idle") {
      // Fade out then unmount
      setVisible(false);
      hideTimerRef.current = setTimeout(() => setRendered(false), 300);
    } else if (phase === "applied") {
      // Show briefly, then fade
      setRendered(true);
      requestAnimationFrame(() => setVisible(true));
      hideTimerRef.current = setTimeout(() => {
        setVisible(false);
        hideTimerRef.current = setTimeout(() => setRendered(false), 300);
      }, 2500);
    } else {
      // Active states: show immediately
      setRendered(true);
      requestAnimationFrame(() => setVisible(true));
    }

    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [phase]);

  if (!rendered || phase === "idle") return null;

  const config = PHASE_CONFIG[phase];

  return (
    <div
      className={`
        pointer-events-none fixed bottom-4 right-4 z-50
        transition-all duration-300 ease-out
        ${visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"}
      `}
    >
      <div className="inline-flex items-center gap-2 rounded-full border border-neutral-800/50 bg-neutral-950/80 px-3 py-1.5 backdrop-blur-sm">
        <StatusPulseDot
          status={config.status}
          size="sm"
          pulse={config.pulse}
          pulseSeed={resourceId}
        />
        <span className="font-mono text-[11px] text-neutral-300">
          {config.label}
        </span>
      </div>
    </div>
  );
}
