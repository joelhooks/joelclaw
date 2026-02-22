"use client";

/**
 * ReviewWrapper — wraps any content to enable paragraph-level commenting.
 *
 * ADR-0106. Generic — works for ADRs, posts, discoveries, any MDX content.
 *
 * Selection modes:
 *   plain click  — select single paragraph (deselect others)
 *   cmd/ctrl     — toggle paragraph in/out of selection
 *   shift        — range select from last clicked to current
 *   esc          — clear all
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { InlineComment } from "@/components/review/inline-comment";
import { ReviewFab } from "@/components/review/review-fab";

interface ReviewWrapperProps {
  contentId: string;
  contentType: string;
  contentSlug: string;
  children: React.ReactNode;
}

/** Get all paragraph IDs in DOM order */
function getAllParagraphIds(): string[] {
  const els = document.querySelectorAll("[data-paragraph-id]");
  const ids: string[] = [];
  els.forEach((el) => {
    const id = el.getAttribute("data-paragraph-id");
    if (id) ids.push(id);
  });
  return ids;
}

export function ReviewWrapper({
  contentId,
  contentType,
  contentSlug,
  children,
}: ReviewWrapperProps) {
  const [selectedParagraphs, setSelectedParagraphs] = useState<Set<string>>(
    new Set(),
  );
  const lastClickedRef = useRef<string | null>(null);

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

  // Inject comment count indicators
  useEffect(() => {
    if (!allComments) return;

    document
      .querySelectorAll("[data-comment-indicator]")
      .forEach((el) => el.remove());

    for (const [paragraphId, count] of draftsByParagraph) {
      const el = document.querySelector(
        `[data-paragraph-id="${paragraphId}"]`,
      );
      if (!el || selectedParagraphs.has(paragraphId)) continue;

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
  }, [allComments, selectedParagraphs]);

  // Apply highlight classes to selected paragraphs
  useEffect(() => {
    const highlightClasses = [
      "ring-1",
      "ring-claw/30",
      "bg-claw/[0.03]",
      "rounded",
    ];

    // Remove from all
    document.querySelectorAll("[data-paragraph-id]").forEach((el) => {
      el.classList.remove(...highlightClasses);
    });

    // Add to selected
    for (const id of selectedParagraphs) {
      const el = document.querySelector(`[data-paragraph-id="${id}"]`);
      if (el) el.classList.add(...highlightClasses);
    }

    return () => {
      document.querySelectorAll("[data-paragraph-id]").forEach((el) => {
        el.classList.remove(...highlightClasses);
      });
    };
  }, [selectedParagraphs]);

  const clearSelection = useCallback(() => {
    setSelectedParagraphs(new Set());
    lastClickedRef.current = null;
  }, []);

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

      const isMeta = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      if (isShift && lastClickedRef.current) {
        // Range select
        const allIds = getAllParagraphIds();
        const lastIdx = allIds.indexOf(lastClickedRef.current);
        const currIdx = allIds.indexOf(paragraphId);
        if (lastIdx !== -1 && currIdx !== -1) {
          const start = Math.min(lastIdx, currIdx);
          const end = Math.max(lastIdx, currIdx);
          const range = allIds.slice(start, end + 1);

          setSelectedParagraphs((prev) => {
            const next = new Set(isMeta ? prev : []);
            for (const id of range) next.add(id);
            return next;
          });
        }
      } else if (isMeta) {
        // Toggle single
        setSelectedParagraphs((prev) => {
          const next = new Set(prev);
          if (next.has(paragraphId)) {
            next.delete(paragraphId);
          } else {
            next.add(paragraphId);
          }
          return next;
        });
        lastClickedRef.current = paragraphId;
      } else {
        // Plain click — single select or deselect if already the only one
        if (
          selectedParagraphs.size === 1 &&
          selectedParagraphs.has(paragraphId)
        ) {
          clearSelection();
        } else {
          setSelectedParagraphs(new Set([paragraphId]));
          lastClickedRef.current = paragraphId;
        }
      }
    },
    [selectedParagraphs, clearSelection],
  );

  // The inline comment attaches to the last selected paragraph
  // (or the single one if only one is selected)
  const commentAnchor =
    selectedParagraphs.size > 0
      ? Array.from(selectedParagraphs).pop()!
      : null;

  return (
    <>
      <div
        onClick={handleClick}
        className="[&_[data-paragraph-id]]:transition-colors [&_[data-paragraph-id]:hover]:bg-neutral-800/15 [&_[data-paragraph-id]]:rounded [&_[data-paragraph-id]]:cursor-pointer [&_[data-paragraph-id]]:-mx-2 [&_[data-paragraph-id]]:px-2 [&_[data-paragraph-id]]:py-0.5"
      >
        {children}
      </div>

      {commentAnchor && (
        <InlineComment
          contentId={contentId}
          paragraphId={commentAnchor}
          selectedParagraphs={Array.from(selectedParagraphs)}
          onClose={clearSelection}
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
