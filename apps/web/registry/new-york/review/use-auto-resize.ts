"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Auto-resize a textarea to fit its content with smooth animation.
 *
 * Uses CSS transition on max-height for buttery expansion.
 * Collapses back when content is deleted.
 */
export function useAutoResize(minHeight = 48, maxHeight = 240) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    // Temporarily collapse to measure scrollHeight accurately
    el.style.height = "auto";
    const scrollH = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${scrollH}px`;
  }, [minHeight, maxHeight]);

  // Set up transition styles on mount
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    el.style.transition = "height 150ms cubic-bezier(0.22, 1, 0.36, 1)";
    el.style.overflow = "hidden";
    el.style.minHeight = `${minHeight}px`;
    el.style.maxHeight = `${maxHeight}px`;

    resize();
  }, [minHeight, maxHeight, resize]);

  return { ref, resize };
}
