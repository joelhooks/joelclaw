"use client";

import { type ReactNode, useEffect, useState } from "react";

interface LazyReviewGateProps {
  contentId: string;
  contentType: string;
  contentSlug: string;
  children: ReactNode;
  enabled?: boolean;
}

function hasTruthyParam(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Lazily loads ConvexReviewGate only after client hydration.
 * Avoids importing convex/react during static prerender entirely —
 * ConvexReactClient calls Date.now() at module scope which breaks
 * cacheComponents prerender.
 *
 * Default behavior: disabled unless URL has ?review=1 (or truthy variants).
 */
type LoadedGateProps = Omit<LazyReviewGateProps, "enabled">;

export function LazyReviewGate({ enabled, ...props }: LazyReviewGateProps) {
  const [Gate, setGate] = useState<React.ComponentType<LoadedGateProps> | null>(null);
  const [queryEnabled, setQueryEnabled] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQueryEnabled(hasTruthyParam(params.get("review")));
  }, []);

  const active = enabled ?? queryEnabled;

  useEffect(() => {
    if (!active) return;

    import("@/components/review/convex-review-gate").then((m) => {
      setGate(() => m.ConvexReviewGate);
    });
  }, [active]);

  if (!active || !Gate) return <>{props.children}</>;
  return <Gate {...props} />;
}
