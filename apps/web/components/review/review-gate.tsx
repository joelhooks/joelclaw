"use client";

/**
 * ReviewGate — auth gate for the review system.
 *
 * Shows review UI only if the current user is the owner (GitHub ID 86834).
 * Wraps children in ReviewWrapper when authed, passes through when not.
 *
 * While loading (undefined), renders children without wrapper to avoid CLS.
 * The wrapper only adds click handlers + FAB — no layout change.
 */
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ReviewWrapper } from "@/components/review/review-wrapper";

interface ReviewGateProps {
  contentId: string;
  contentType: string;
  contentSlug: string;
  children: React.ReactNode;
}

export function ReviewGate({
  contentId,
  contentType,
  contentSlug,
  children,
}: ReviewGateProps) {
  const isOwner = useQuery(api.auth.isOwner);

  // undefined = loading, false = not owner — both render without wrapper
  if (isOwner !== true) {
    return <>{children}</>;
  }

  return (
    <ReviewWrapper
      contentId={contentId}
      contentType={contentType}
      contentSlug={contentSlug}
    >
      {children}
    </ReviewWrapper>
  );
}
