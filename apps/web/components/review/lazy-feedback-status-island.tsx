"use client";

import { type ComponentType, useEffect, useState } from "react";

interface LazyFeedbackStatusIslandProps {
  resourceId: string;
  enabled?: boolean;
}

function hasTruthyParam(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Defers the Convex island import until after hydration to keep
 * static prerender paths free from convex/react module evaluation.
 *
 * Default behavior: disabled unless URL has ?review=1.
 */
type LoadedFeedbackIslandProps = Omit<LazyFeedbackStatusIslandProps, "enabled">;

export function LazyFeedbackStatusIsland({
  resourceId,
  enabled,
}: LazyFeedbackStatusIslandProps) {
  const [Island, setIsland] = useState<ComponentType<LoadedFeedbackIslandProps> | null>(
    null,
  );
  const [queryEnabled, setQueryEnabled] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQueryEnabled(hasTruthyParam(params.get("review")));
  }, []);

  const active = enabled ?? queryEnabled;

  useEffect(() => {
    if (!active) return;

    import("@/components/review/feedback-status-island").then((m) => {
      setIsland(() => m.FeedbackStatusIsland);
    });
  }, [active]);

  if (!active || !Island) return null;
  return <Island resourceId={resourceId} />;
}
