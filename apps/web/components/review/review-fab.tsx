"use client";

import { useQuery } from "convex/react";
import { MessageSquarePlus } from "lucide-react";
/**
 * ReviewFAB — floating action button showing draft comment count.
 *
 * ADR-0106. Fixed bottom-right. Only visible when there are draft comments.
 * Tapping opens the ReviewSheet.
 */
import { useState } from "react";
import { ReviewSheet } from "@/components/review/review-sheet";
import { api } from "@/convex/_generated/api";

interface ReviewFabProps {
  contentId: string;
  contentType: string;
  contentSlug: string;
}

export function ReviewFab({ contentId, contentType, contentSlug }: ReviewFabProps) {
  const [open, setOpen] = useState(false);
  const count = useQuery(api.reviewComments.draftCount, { contentId });
  const feedbackItems = useQuery(api.feedback.listByResource, {
    resourceId: contentId,
  });
  const isProcessingFeedback =
    feedbackItems?.some((item) => item.status === "processing") ?? false;

  if (!count || count === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={isProcessingFeedback}
        className={`fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full border bg-neutral-950/90 backdrop-blur-sm px-4 py-2.5 shadow-lg shadow-claw/5 transition-[color,background-color,border-color,transform,box-shadow,opacity] duration-200 ease-out motion-reduce:transition-none group ${
          isProcessingFeedback
            ? "cursor-not-allowed border-amber-500/30 opacity-50"
            : "border-claw/30 hover:border-claw/50 hover:bg-neutral-900/90 active:scale-[0.97] motion-reduce:active:scale-100"
        }`}
        aria-label={`Review ${count} draft comments`}
      >
        <MessageSquarePlus
          className={`w-4 h-4 transition-colors ${
            isProcessingFeedback
              ? "text-amber-300/80"
              : "text-claw/70 group-hover:text-claw"
          }`}
        />
        <span
          className={`font-mono text-xs tabular-nums ${
            isProcessingFeedback ? "text-amber-200/90" : "text-claw"
          }`}
        >
          {count}
        </span>
      </button>

      <ReviewSheet
        open={open}
        onOpenChange={setOpen}
        contentId={contentId}
        contentType={contentType}
        contentSlug={contentSlug}
        resourceId={contentId}
      />
    </>
  );
}
