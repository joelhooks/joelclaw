"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Component, type ErrorInfo, type ReactNode, useRef } from "react";
import { FeedbackStatus } from "@/components/review/feedback-status";

interface FeedbackStatusIslandProps {
  resourceId: string;
}

class FeedbackErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[FeedbackStatus] silenced:", error.message, info.componentStack);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function useConvexClient() {
  const ref = useRef<ConvexReactClient | null>(null);
  if (!ref.current) {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) return null;
    ref.current = new ConvexReactClient(url);
  }
  return ref.current;
}

export function FeedbackStatusIsland({ resourceId }: FeedbackStatusIslandProps) {
  const convex = useConvexClient();

  if (!convex) return null;

  return (
    <FeedbackErrorBoundary>
      <ConvexProvider client={convex}>
        <FeedbackStatus resourceId={resourceId} />
      </ConvexProvider>
    </FeedbackErrorBoundary>
  );
}
