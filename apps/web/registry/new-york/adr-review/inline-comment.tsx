"use client";

/**
 * InlineComment — comment editor that renders directly below a paragraph.
 *
 * ADR-0106. Replaces the bottom drawer approach.
 * Mounts via portal into a container div inserted after the target paragraph.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, Send, Pencil, X } from "lucide-react";

interface InlineCommentProps {
  adrSlug: string;
  paragraphId: string;
  onClose: () => void;
}

export function InlineComment({
  adrSlug,
  paragraphId,
  onClose,
}: InlineCommentProps) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<Id<"adrComments"> | null>(null);
  const [editContent, setEditContent] = useState("");
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const allComments = useQuery(api.adrComments.getByAdr, { adrSlug });
  const addComment = useMutation(api.adrComments.addComment);
  const updateComment = useMutation(api.adrComments.updateComment);
  const deleteComment = useMutation(api.adrComments.deleteComment);

  const comments =
    allComments?.filter(
      (c) => c.paragraphId === paragraphId && c.status === "draft",
    ) ?? [];

  // Create and insert container div after the target paragraph
  useEffect(() => {
    const target = document.querySelector(
      `[data-paragraph-id="${paragraphId}"]`,
    );
    if (!target) return;

    // Highlight the paragraph
    target.classList.add(
      "ring-1",
      "ring-claw/30",
      "bg-claw/[0.03]",
      "rounded",
    );

    // Scroll into view
    target.scrollIntoView({ behavior: "smooth", block: "center" });

    // Create container
    const div = document.createElement("div");
    div.setAttribute("data-inline-comment", paragraphId);
    target.after(div);
    setContainer(div);

    // Focus textarea after mount
    setTimeout(() => textareaRef.current?.focus(), 100);

    return () => {
      target.classList.remove(
        "ring-1",
        "ring-claw/30",
        "bg-claw/[0.03]",
        "rounded",
      );
      div.remove();
    };
  }, [paragraphId]);

  const handleSubmit = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    await addComment({ adrSlug, paragraphId, content: text });
    setDraft("");
    textareaRef.current?.focus();
  }, [draft, adrSlug, paragraphId, addComment]);

  const handleSaveEdit = useCallback(async () => {
    if (!editingId || !editContent.trim()) return;
    await updateComment({ id: editingId, content: editContent.trim() });
    setEditingId(null);
    setEditContent("");
  }, [editingId, editContent, updateComment]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (editingId) handleSaveEdit();
      else handleSubmit();
    }
    if (e.key === "Escape") {
      onClose();
    }
  };

  if (!container) return null;

  return createPortal(
    <div className="my-3 ml-0 rounded-lg border border-neutral-800/60 bg-neutral-900/50 backdrop-blur-sm overflow-hidden animate-in slide-in-from-top-2 fade-in duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-neutral-800/40">
        <span className="text-[10px] font-mono text-neutral-600 tracking-wider uppercase">
          comment
        </span>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-neutral-600 hover:text-neutral-300 transition-colors"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Existing comments */}
      {comments.length > 0 && (
        <div className="px-3 pt-2 space-y-1.5">
          {comments.map((comment) => (
            <div
              key={comment._id}
              className="group relative rounded border border-neutral-800/30 bg-neutral-950/40 px-2.5 py-1.5"
            >
              {editingId === comment._id ? (
                <div className="space-y-1.5">
                  <Textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="min-h-[48px] resize-none border-neutral-700 bg-neutral-900 text-sm text-neutral-200 placeholder:text-neutral-600 focus-visible:ring-claw/30"
                    autoFocus
                  />
                  <div className="flex gap-1 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[10px] text-neutral-500"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="h-6 px-1.5 text-[10px] bg-claw/10 text-claw hover:bg-claw/20 border border-claw/20"
                      onClick={handleSaveEdit}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-[13px] text-neutral-300 leading-relaxed whitespace-pre-wrap pr-10">
                    {comment.content}
                  </p>
                  <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => {
                        setEditingId(comment._id);
                        setEditContent(comment.content);
                      }}
                      className="p-1 rounded text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => deleteComment({ id: comment._id })}
                      className="p-1 rounded text-neutral-600 hover:text-red-400 hover:bg-neutral-800 transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Compose */}
      <div className="p-3">
        <div className="relative">
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add a comment…"
            rows={2}
            className="min-h-[48px] resize-none border-neutral-800 bg-neutral-950/60 text-sm text-neutral-200 placeholder:text-neutral-600 focus-visible:ring-claw/30 pr-9"
          />
          <button
            onClick={handleSubmit}
            disabled={!draft.trim()}
            className="absolute bottom-1.5 right-1.5 p-1 rounded text-neutral-500 hover:text-claw disabled:opacity-30 disabled:hover:text-neutral-500 transition-colors"
            aria-label="Add comment"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="mt-1 text-[9px] text-neutral-700 font-mono">
          ⌘↵ save · esc close
        </p>
      </div>
    </div>,
    container,
  );
}
