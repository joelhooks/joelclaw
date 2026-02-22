"use client";

/**
 * InlineComment — comment editor that renders directly below a paragraph.
 *
 * ADR-0106. Portal-based: mounts a container div after the target paragraph.
 * Works on any content type. Supports multi-paragraph selection — the comment
 * is stored against the anchor paragraph but shows which paragraphs are selected.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, Send, Pencil, X } from "lucide-react";

interface InlineCommentProps {
  contentId: string;
  paragraphId: string; // anchor — where the portal mounts
  selectedParagraphs?: string[]; // all selected IDs (for multi-select)
  onClose: () => void;
}

export function InlineComment({
  contentId,
  paragraphId,
  selectedParagraphs,
  onClose,
}: InlineCommentProps) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selected = selectedParagraphs ?? [paragraphId];
  const isMulti = selected.length > 1;

  const allComments = useQuery(api.reviewComments.getByContent, { contentId });
  const addComment = useMutation(api.reviewComments.addComment);
  const updateComment = useMutation(api.reviewComments.updateComment);
  const deleteComment = useMutation(api.reviewComments.deleteComment);

  // Show comments for ALL selected paragraphs
  const selectedSet = new Set(selected);
  const comments =
    allComments?.filter(
      (c) => selectedSet.has(c.paragraphId) && c.status === "draft",
    ) ?? [];

  // Mount after the anchor paragraph
  useEffect(() => {
    const target = document.querySelector(
      `[data-paragraph-id="${paragraphId}"]`,
    );
    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "center" });

    const div = document.createElement("div");
    div.setAttribute("data-inline-comment", paragraphId);
    target.after(div);
    setContainer(div);

    setTimeout(() => textareaRef.current?.focus(), 100);

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEsc);

    return () => {
      document.removeEventListener("keydown", handleEsc);
      div.remove();
    };
  }, [paragraphId, onClose]);

  const handleSubmit = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;

    // For multi-select, prefix content with selection context
    const prefix =
      isMulti
        ? `[Applies to ${selected.length} paragraphs: ${selected.map((id) => `#${id}`).join(", ")}]\n\n`
        : "";

    await addComment({
      contentId,
      paragraphId, // anchor
      content: prefix + text,
    });
    setDraft("");
    textareaRef.current?.focus();
  }, [draft, contentId, paragraphId, addComment, isMulti, selected]);

  const handleSaveEdit = useCallback(async () => {
    if (!editingId || !editContent.trim()) return;
    await updateComment({ resourceId: editingId, content: editContent.trim() });
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
      setDraft("");
      setEditingId(null);
      onClose();
    }
  };

  if (!container) return null;

  return createPortal(
    <div className="my-3 ml-0 rounded-lg border border-neutral-800/60 bg-neutral-900/50 backdrop-blur-sm overflow-hidden animate-in slide-in-from-top-2 fade-in duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-neutral-800/40">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-neutral-600 tracking-wider uppercase">
            comment
          </span>
          {isMulti && (
            <span className="text-[9px] font-mono text-claw/60 bg-claw/5 border border-claw/15 rounded px-1 py-0.5">
              {selected.length} paragraphs
            </span>
          )}
        </div>
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
              key={comment.resourceId}
              className="group relative rounded border border-neutral-800/30 bg-neutral-950/40 px-2.5 py-1.5"
            >
              {editingId === comment.resourceId ? (
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
                        setEditingId(comment.resourceId);
                        setEditContent(comment.content);
                      }}
                      className="p-1 rounded text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() =>
                        deleteComment({ resourceId: comment.resourceId })
                      }
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
            placeholder={
              isMulti
                ? `Comment on ${selected.length} paragraphs…`
                : "Add a comment…"
            }
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
          ⌘↵ save · esc close · ⌘click multi-select · ⇧click range
        </p>
      </div>
    </div>,
    container,
  );
}
