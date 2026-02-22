"use client";

/**
 * AdrReviewWrapper — wraps ADR content area to enable paragraph-level commenting.
 *
 * ADR-0106. Handles:
 * - Click detection on paragraphs with [data-paragraph-id]
 * - Opening CommentDrawer for the selected paragraph
 * - Rendering comment count indicators on annotated paragraphs
 * - ReviewFab for the "Submit Review" flow
 *
 * Mobile-first: tap to comment, no hover states required.
 */
import { useState, useCallback, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { CommentDrawer } from "@/components/adr-review/comment-drawer";
import { ReviewFab } from "@/components/adr-review/review-fab";

interface AdrReviewWrapperProps {
  adrSlug: string;
  children: React.ReactNode;
}

export function AdrReviewWrapper({ adrSlug, children }: AdrReviewWrapperProps) {
  const [selectedParagraph, setSelectedParagraph] = useState<{
    id: string;
    snippet: string;
  } | null>(null);

  const allComments = useQuery(api.adrComments.getByAdr, { adrSlug });
  const draftsByParagraph = new Map<string, number>();

  if (allComments) {
    for (const c of allComments) {
      if (c.status === "draft") {
        draftsByParagraph.set(
          c.paragraphId,
          (draftsByParagraph.get(c.paragraphId) ?? 0) + 1,
        );
      }
    }
  }

  // Inject comment indicators into the DOM
  useEffect(() => {
    if (!allComments) return;

    // Clean up previous indicators
    document
      .querySelectorAll("[data-comment-indicator]")
      .forEach((el) => el.remove());

    for (const [paragraphId, count] of draftsByParagraph) {
      const el = document.querySelector(
        `[data-paragraph-id="${paragraphId}"]`,
      );
      if (!el) continue;

      // Position relative for the indicator
      const htmlEl = el as HTMLElement;
      if (getComputedStyle(htmlEl).position === "static") {
        htmlEl.style.position = "relative";
      }

      // Create indicator
      const indicator = document.createElement("span");
      indicator.setAttribute("data-comment-indicator", "true");
      indicator.className =
        "absolute -left-6 top-0.5 flex items-center justify-center w-4 h-4 rounded-full bg-claw/10 border border-claw/25 text-[9px] font-mono text-claw tabular-nums pointer-events-none select-none";
      indicator.textContent = String(count);
      htmlEl.prepend(indicator);
    }

    return () => {
      document
        .querySelectorAll("[data-comment-indicator]")
        .forEach((el) => el.remove());
    };
  }, [allComments]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    // Walk up to find a commentable element
    const commentable = target.closest("[data-paragraph-id]") as HTMLElement | null;
    if (!commentable) return;

    // Don't intercept link clicks
    if (target.closest("a")) return;

    const paragraphId = commentable.getAttribute("data-paragraph-id");
    if (!paragraphId) return;

    // Get snippet text
    const snippet = (commentable.textContent ?? "").trim().slice(0, 120);

    setSelectedParagraph({ id: paragraphId, snippet });
  }, []);

  return (
    <>
      {/* Content area — click handler for paragraph selection */}
      <div
        onClick={handleClick}
        className="cursor-text [&_[data-paragraph-id]]:relative [&_[data-paragraph-id]]:transition-colors [&_[data-paragraph-id]:hover]:bg-neutral-800/20 [&_[data-paragraph-id]]:rounded [&_[data-paragraph-id]]:cursor-pointer [&_[data-paragraph-id]]:-mx-2 [&_[data-paragraph-id]]:px-2"
      >
        {children}
      </div>

      {/* Comment drawer */}
      <CommentDrawer
        open={!!selectedParagraph}
        onOpenChange={(open) => {
          if (!open) setSelectedParagraph(null);
        }}
        adrSlug={adrSlug}
        paragraphId={selectedParagraph?.id ?? ""}
        paragraphSnippet={selectedParagraph?.snippet ?? ""}
      />

      {/* FAB for review summary */}
      <ReviewFab adrSlug={adrSlug} />
    </>
  );
}
