"use client";

/**
 * ReviewFAB — floating action button showing draft comment count.
 *
 * ADR-0106. Fixed bottom-right. Only visible when there are draft comments.
 * Tapping opens the ReviewSheet.
 */
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ReviewSheet } from "@/components/review/review-sheet";
import { MessageSquarePlus } from "lucide-react";

interface ReviewFabProps {
  contentId: string;
  contentType: string;
  contentSlug: string;
}

export function ReviewFab({ contentId, contentType, contentSlug }: ReviewFabProps) {
  const [open, setOpen] = useState(false);
  const count = useQuery(api.reviewComments.draftCount, { contentId });

  if (!count || count === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full border border-claw/30 bg-neutral-950/90 backdrop-blur-sm px-4 py-2.5 shadow-lg shadow-claw/5 hover:border-claw/50 hover:bg-neutral-900/90 transition-[color,background-color,border-color,transform,box-shadow] duration-200 ease-out active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 group"
        aria-label={`Review ${count} draft comments`}
      >
        <MessageSquarePlus className="w-4 h-4 text-claw/70 group-hover:text-claw transition-colors" />
        <span className="font-mono text-xs text-claw tabular-nums">{count}</span>
      </button>

      <ReviewSheet
        open={open}
        onOpenChange={setOpen}
        contentId={contentId}
        contentType={contentType}
        contentSlug={contentSlug}
      />
    </>
  );
}
