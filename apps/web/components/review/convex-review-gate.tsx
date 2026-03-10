"use client";

import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";
/**
 * ConvexReviewGate — self-contained review gate with its own Convex provider.
 *
 * Used on public pages (ADRs, blog posts) outside the (owner) route group.
 * Lazily creates the Convex client on first render to avoid Date.now()
 * during static prerender.
 */
import { useRef } from "react";
import { ReviewGate } from "@/components/review/review-gate";
import { authClient } from "@/lib/auth-client";

function useConvexClient() {
  const ref = useRef<ConvexReactClient | null>(null);
  const url = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!url) return null;

  if (!ref.current) {
    ref.current = new ConvexReactClient(url);
  }
  return ref.current;
}

interface ConvexReviewGateProps {
  contentId: string;
  contentType: string;
  contentSlug: string;
  children: React.ReactNode;
}

export function ConvexReviewGate({
  contentId,
  contentType,
  contentSlug,
  children,
}: ConvexReviewGateProps) {
  const convex = useConvexClient();
  if (!convex) return <>{children}</>;

  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient}>
      <ReviewGate
        contentId={contentId}
        contentType={contentType}
        contentSlug={contentSlug}
      >
        {children}
      </ReviewGate>
    </ConvexBetterAuthProvider>
  );
}
