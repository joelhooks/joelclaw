"use client";

/**
 * CommentDrawer — bottom sheet for adding/viewing comments on a paragraph.
 *
 * ADR-0106. Mobile-first: slides up from bottom, snap points at 40% and 85%.
 * Shows existing thread for the selected paragraph and a compose input.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, Send, Pencil, X } from "lucide-react";

interface CommentDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adrSlug: string;
  paragraphId: string;
  /** First ~120 chars of the paragraph for context */
  paragraphSnippet: string;
}

export function CommentDrawer({
  open,
  onOpenChange,
  adrSlug,
  paragraphId,
  paragraphSnippet,
}: CommentDrawerProps) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<Id<"adrComments"> | null>(null);
  const [editContent, setEditContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const allComments = useQuery(api.adrComments.getByAdr, { adrSlug });
  const addComment = useMutation(api.adrComments.addComment);
  const updateComment = useMutation(api.adrComments.updateComment);
  const deleteComment = useMutation(api.adrComments.deleteComment);

  // Filter to this paragraph's comments
  const comments = allComments?.filter(
    (c) => c.paragraphId === paragraphId && c.status === "draft",
  ) ?? [];

  // Focus textarea on open
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 300);
    } else {
      setDraft("");
      setEditingId(null);
    }
  }, [open]);

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
      if (editingId) {
        handleSaveEdit();
      } else {
        handleSubmit();
      }
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="border-neutral-800 bg-neutral-950">
        <div className="mx-auto w-full max-w-lg">
          <DrawerHeader className="pb-2">
            <DrawerTitle className="text-sm font-mono text-neutral-400 tracking-tight">
              Comment
            </DrawerTitle>
            {paragraphSnippet && (
              <p className="mt-1 text-xs text-neutral-600 leading-relaxed line-clamp-2 font-mono">
                "{paragraphSnippet}"
              </p>
            )}
          </DrawerHeader>

          {/* Existing comments */}
          {comments.length > 0 && (
            <div className="px-4 space-y-2 max-h-[30vh] overflow-y-auto scrollbar-thin">
              {comments.map((comment) => (
                <div
                  key={comment._id}
                  className="group relative rounded-md border border-neutral-800/60 bg-neutral-900/40 px-3 py-2"
                >
                  {editingId === comment._id ? (
                    <div className="space-y-2">
                      <Textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="min-h-[60px] resize-none border-neutral-700 bg-neutral-900 text-sm text-neutral-200 placeholder:text-neutral-600 focus-visible:ring-claw/30"
                        autoFocus
                      />
                      <div className="flex gap-1.5 justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-neutral-500"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 px-2 text-xs bg-claw/10 text-claw hover:bg-claw/20 border border-claw/20"
                          onClick={handleSaveEdit}
                        >
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap">
                        {comment.content}
                      </p>
                      <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => {
                            setEditingId(comment._id);
                            setEditContent(comment.content);
                          }}
                          className="p-1 rounded text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
                          aria-label="Edit comment"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => deleteComment({ id: comment._id })}
                          className="p-1 rounded text-neutral-600 hover:text-red-400 hover:bg-neutral-800 transition-colors"
                          aria-label="Delete comment"
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
          <DrawerFooter className="pt-3">
            <div className="relative">
              <Textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add a comment…"
                className="min-h-[80px] resize-none border-neutral-800 bg-neutral-900/60 text-sm text-neutral-200 placeholder:text-neutral-600 focus-visible:ring-claw/30 pr-10"
              />
              <button
                onClick={handleSubmit}
                disabled={!draft.trim()}
                className="absolute bottom-2 right-2 p-1.5 rounded-md text-neutral-500 hover:text-claw disabled:opacity-30 disabled:hover:text-neutral-500 transition-colors"
                aria-label="Add comment"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[10px] text-neutral-700 text-center font-mono">
              ⌘↵ to save
            </p>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
