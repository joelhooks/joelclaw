"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useRef } from "react";
import { FeedbackStatus } from "@/components/review/feedback-status";

interface FeedbackStatusIslandProps {
  resourceId: string;
}

function useConvexClient() {
  const ref = useRef<ConvexReactClient | null>(null);
  if (!ref.current) {
    ref.current = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  }
  return ref.current;
}

export function FeedbackStatusIsland({ resourceId }: FeedbackStatusIslandProps) {
  const convex = useConvexClient();

  return (
    <ConvexProvider client={convex}>
      <FeedbackStatus resourceId={resourceId} />
    </ConvexProvider>
  );
}
