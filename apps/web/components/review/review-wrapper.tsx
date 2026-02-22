"use client";

/**
 * ReviewWrapper — wraps any content to enable paragraph-level commenting.
 *
 * ADR-0106. Generic — works for ADRs, posts, discoveries, any MDX content.
 * Handles click detection on [data-paragraph-id] elements, inline comment
 * editor, comment count indicators, and the submit review FAB.
 */
import { useState, useCallback, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { InlineComment } from "@/components/review/inline-comment";
import { ReviewFab } from "@/components/review/review-fab";

interface ReviewWrapperProps {
  contentId: string; // resourceId, e.g. "adr:0106-slug"
  contentType: string; // "adr" | "post" | "discovery"
  contentSlug: string; // slug for Inngest event
  children: React.ReactNode;
}

export function ReviewWrapper({
  contentId,
  contentType,
  contentSlug,
  children,
}: ReviewWrapperProps) {
  const [activeParagraph, setActiveParagraph] = useState<string | null>(null);

  const allComments = useQuery(api.reviewComments.getByContent, { contentId });
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

  // Inject comment count indicators into the DOM
  useEffect(() => {
    if (!allComments) return;

    document
      .querySelectorAll("[data-comment-indicator]")
      .forEach((el) => el.remove());

    for (const [paragraphId, count] of draftsByParagraph) {
      const el = document.querySelector(
        `[data-paragraph-id="${paragraphId}"]`,
      );
      if (!el || paragraphId === activeParagraph) continue;

      const htmlEl = el as HTMLElement;
      if (getComputedStyle(htmlEl).position === "static") {
        htmlEl.style.position = "relative";
      }

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
  }, [allComments, activeParagraph]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;

      if (target.closest("a")) return;
      if (target.closest("[data-inline-comment]")) return;

      const commentable = target.closest(
        "[data-paragraph-id]",
      ) as HTMLElement | null;
      if (!commentable) return;

      const paragraphId = commentable.getAttribute("data-paragraph-id");
      if (!paragraphId) return;

      if (activeParagraph === paragraphId) {
        setActiveParagraph(null);
      } else {
        setActiveParagraph(paragraphId);
      }
    },
    [activeParagraph],
  );

  return (
    <>
      <div
        onClick={handleClick}
        className="[&_[data-paragraph-id]]:transition-colors [&_[data-paragraph-id]:hover]:bg-neutral-800/15 [&_[data-paragraph-id]]:rounded [&_[data-paragraph-id]]:cursor-pointer [&_[data-paragraph-id]]:-mx-2 [&_[data-paragraph-id]]:px-2 [&_[data-paragraph-id]]:py-0.5"
      >
        {children}
      </div>

      {activeParagraph && (
        <InlineComment
          contentId={contentId}
          paragraphId={activeParagraph}
          onClose={() => setActiveParagraph(null)}
        />
      )}

      <ReviewFab
        contentId={contentId}
        contentType={contentType}
        contentSlug={contentSlug}
      />
    </>
  );
}
