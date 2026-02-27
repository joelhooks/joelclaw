"use client";

import { type ComponentType, useEffect, useState } from "react";

interface LazyFeedbackStatusIslandProps {
  resourceId: string;
}

/**
 * Defers the Convex island import until after hydration to keep
 * static prerender paths free from convex/react module evaluation.
 */
export function LazyFeedbackStatusIsland({
  resourceId,
}: LazyFeedbackStatusIslandProps) {
  const [Island, setIsland] = useState<ComponentType<LazyFeedbackStatusIslandProps> | null>(
    null,
  );

  useEffect(() => {
    import("@/components/review/feedback-status-island").then((m) => {
      setIsland(() => m.FeedbackStatusIsland);
    });
  }, []);

  if (!Island) return null;
  return <Island resourceId={resourceId} />;
}
