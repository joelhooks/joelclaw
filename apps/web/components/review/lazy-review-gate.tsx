"use client";

import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

interface LazyReviewGateProps {
  contentId: string;
  contentType: string;
  contentSlug: string;
  children: ReactNode;
  enabled?: boolean;
}

/**
 * Lazily loads ConvexReviewGate only after client hydration.
 * Avoids importing convex/react during static prerender entirely —
 * ConvexReactClient calls Date.now() at module scope which breaks
 * cacheComponents prerender.
 *
 * Default behavior: enabled when the user is authenticated.
 */
type LoadedGateProps = Omit<LazyReviewGateProps, "enabled">;

export function LazyReviewGate({ enabled, ...props }: LazyReviewGateProps) {
  const [Gate, setGate] = useState<ComponentType<LoadedGateProps> | null>(null);
  const { data: session } = authClient.useSession();
  const active = enabled ?? !!session?.user;

  useEffect(() => {
    if (!active) return;

    import("@/components/review/convex-review-gate").then((m) => {
      setGate(() => m.ConvexReviewGate);
    });
  }, [active]);

  if (!active || !Gate) return <>{props.children}</>;
  return <Gate {...props} />;
}
