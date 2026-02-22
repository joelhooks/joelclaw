"use client";

/**
 * ReviewGate — auth gate for the review system.
 *
 * Shows review UI only if the current user is the owner (GitHub ID 86834).
 * Wraps children in ReviewWrapper when authed, passes through when not.
 */
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ReviewWrapper } from "@/components/review/review-wrapper";

interface ReviewGateProps {
  contentId: string; // resourceId, e.g. "adr:0106-slug"
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

  if (!isOwner) {
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
