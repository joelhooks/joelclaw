"use client";

import { type ReactNode, useEffect, useState } from "react";

interface LazyReviewGateProps {
  contentId: string;
  contentType: string;
  contentSlug: string;
  children: ReactNode;
}

/**
 * Lazily loads ConvexReviewGate only after client hydration.
 * Avoids importing convex/react during static prerender entirely —
 * ConvexReactClient calls Date.now() at module scope which breaks
 * cacheComponents prerender.
 */
export function LazyReviewGate(props: LazyReviewGateProps) {
  const [Gate, setGate] = useState<React.ComponentType<LazyReviewGateProps> | null>(null);

  useEffect(() => {
    import("@/components/review/convex-review-gate").then((m) => {
      setGate(() => m.ConvexReviewGate);
    });
  }, []);

  if (!Gate) return <>{props.children}</>;
  return <Gate {...props} />;
}
