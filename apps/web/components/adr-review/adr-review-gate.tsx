"use client";

/**
 * AdrReviewGate — client component that conditionally wraps ADR content
 * with the review system when the user is the authenticated owner.
 *
 * ADR-0106. Uses Convex isOwner query to gate access.
 * If not owner: renders children directly, zero overhead.
 * If owner: wraps in AdrReviewWrapper with comment detection + FAB.
 */
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AdrReviewWrapper } from "@/components/adr-review/adr-review-wrapper";

interface AdrReviewGateProps {
  adrSlug: string;
  children: React.ReactNode;
}

export function AdrReviewGate({ adrSlug, children }: AdrReviewGateProps) {
  const isOwner = useQuery(api.auth.isOwner);

  if (!isOwner) {
    return <>{children}</>;
  }

  return (
    <>
      {/* Review mode indicator */}
      <div className="mb-4 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-claw/20 bg-claw/5 px-2.5 py-0.5 text-[10px] font-mono text-claw/70 tracking-wider uppercase">
          <span className="w-1.5 h-1.5 rounded-full bg-claw/50 animate-pulse" />
          review mode
        </span>
      </div>

      <AdrReviewWrapper adrSlug={adrSlug}>{children}</AdrReviewWrapper>
    </>
  );
}
