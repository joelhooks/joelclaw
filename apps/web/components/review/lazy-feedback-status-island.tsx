"use client";

import { type ComponentType, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

interface LazyFeedbackStatusIslandProps {
  resourceId: string;
  enabled?: boolean;
}

/**
 * Defers the Convex island import until after hydration to keep
 * static prerender paths free from convex/react module evaluation.
 *
 * Default behavior: enabled when the user is authenticated.
 */
type LoadedFeedbackIslandProps = Omit<LazyFeedbackStatusIslandProps, "enabled">;

export function LazyFeedbackStatusIsland({
  resourceId,
  enabled,
}: LazyFeedbackStatusIslandProps) {
  const [Island, setIsland] = useState<ComponentType<LoadedFeedbackIslandProps> | null>(
    null,
  );
  const { data: session } = authClient.useSession();
  const active = enabled ?? !!session?.user;

  useEffect(() => {
    if (!active) return;

    import("@/components/review/feedback-status-island").then((m) => {
      setIsland(() => m.FeedbackStatusIsland);
    });
  }, [active]);

  if (!active || !Island) return null;
  return <Island resourceId={resourceId} />;
}
