"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  X,
  FileText,
  GitBranch,
  Sparkles,
  BookOpen,
  Brain,
  Terminal,
  Mic,
} from "lucide-react";

type SearchResult = {
  url: string;
  title: string;
  excerpt: string;
  type: string;
  collection: string;
};

function collectionToUrl(hit: {
  collection: string;
  path?: string;
  id?: string;
  title: string;
}): string {
  switch (hit.collection) {
    case "vault_notes":
      return `/vault/${hit.path}`;
    case "blog_posts":
      return `/${hit.path || ""}`;
    case "discoveries":
      return `/cool`;
    case "memory_observations":
      return `/memory`;
    case "system_log":
      return `/syslog`;
    case "voice_transcripts":
      return `/voice`;
    default:
      return "#";
  }
}

function TypeIcon({ collection }: { collection: string }) {
  const base = "w-4 h-4 mt-0.5 shrink-0";
  switch (collection) {
    case "vault_notes":
      return <BookOpen className={`${base} text-emerald-400`} />;
    case "blog_posts":
      return <FileText className={`${base} text-claw`} />;
    case "discoveries":
      return <Sparkles className={`${base} text-purple-400`} />;
    case "memory_observations":
      return <Brain className={`${base} text-amber-400`} />;
    case "system_log":
      return <Terminal className={`${base} text-blue-400`} />;
    case "voice_transcripts":
      return <Mic className={`${base} text-cyan-400`} />;
    default:
      return <FileText className={`${base} text-neutral-400`} />;
  }
}

const COLLECTION_LABELS: Record<string, string> = {
  vault_notes: "vault",
  blog_posts: "article",
  discoveries: "discovery",
  memory_observations: "memory",
  system_log: "syslog",
  voice_transcripts: "voice",
};

const COLLECTION_COLORS: Record<string, string> = {
  vault_notes: "text-emerald-400 border-emerald-800",
  blog_posts: "text-claw border-pink-800",
  discoveries: "text-purple-400 border-purple-800",
  memory_observations: "text-amber-400 border-amber-800",
  system_log: "text-blue-400 border-blue-800",
  voice_transcripts: "text-cyan-400 border-cyan-800",
};

function TypeBadge({ collection }: { collection: string }) {
  const color =
    COLLECTION_COLORS[collection] ?? "text-neutral-500 border-neutral-700";
  const label = COLLECTION_LABELS[collection] ?? collection;

  return (
    <span
      className={`shrink-0 text-[9px] font-medium uppercase tracking-wider border rounded px-1 py-0.5 ${color}`}
    >
      {label}
    </span>
  );
}

export function SearchDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [totalFound, setTotalFound] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const router = useRouter();

  // ⌘K / Ctrl+K global shortcut
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Focus + body scroll lock
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setActiveIndex(0);
      setTotalFound(0);
    }
  }, [open]);

  // Typesense search via /api/search
  const handleSearch = useCallback(async (value: string) => {
    setQuery(value);
    setActiveIndex(0);

    if (!value.trim()) {
      setResults([]);
      setTotalFound(0);
      return;
    }

    // Cancel previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const resp = await fetch(
        `/api/search?q=${encodeURIComponent(value)}`,
        { signal: controller.signal }
      );
      if (!resp.ok) throw new Error("Search failed");
      const data = await resp.json();

      const mapped: SearchResult[] = (data.hits || [])
        .map((h: any) => ({
          url: collectionToUrl(h),
          title: h.title,
          excerpt: h.snippet || "",
          type: COLLECTION_LABELS[h.collection] || h.collection,
          collection: h.collection,
        }));

      setResults(mapped);
      setTotalFound(data.totalFound || 0);
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setResults([]);
        setTotalFound(0);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const navigateTo = useCallback(
    (url: string) => {
      setOpen(false);
      router.push(url);
    },
    [router],
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => {
          const next = Math.min(i + 1, results.length - 1);
          scrollIntoView(next);
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => {
          const next = Math.max(i - 1, 0);
          scrollIntoView(next);
          return next;
        });
      } else if (e.key === "Enter" && results[activeIndex]) {
        e.preventDefault();
        navigateTo(results[activeIndex].url);
      }
    },
    [results, activeIndex, navigateTo],
  );

  function scrollIntoView(index: number) {
    const container = resultsRef.current;
    if (!container) return;
    const items = container.querySelectorAll("[data-result]");
    items[index]?.scrollIntoView({ block: "nearest" });
  }

  return (
    <>
      {/* Trigger */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-neutral-500 hover:text-white transition-colors"
        aria-label="Search (⌘K)"
      >
        <Search className="w-4 h-4" />
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-neutral-700 bg-neutral-800/50 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
          ⌘K
        </kbd>
      </button>

      {/* Dialog */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4 search-overlay"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-xl bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl shadow-black/50 search-panel overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800">
              <Search className="w-5 h-5 text-neutral-500 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => handleSearch(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search everything…"
                className="flex-1 bg-transparent text-lg text-neutral-100 placeholder:text-neutral-600 outline-none"
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button
                  onClick={() => {
                    setQuery("");
                    setResults([]);
                    inputRef.current?.focus();
                  }}
                  className="text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Results */}
            {query.trim() ? (
              <div
                ref={resultsRef}
                className="max-h-[60vh] overflow-y-auto overscroll-contain scrollbar-thin"
              >
                {results.length > 0 ? (
                  <>
                    <ul className="py-2">
                      {results.map((result, i) => (
                        <li key={`${result.collection}-${result.url}-${i}`} data-result="">
                          <button
                            onClick={() => navigateTo(result.url)}
                            onMouseEnter={() => setActiveIndex(i)}
                            className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors cursor-pointer ${
                              i === activeIndex
                                ? "bg-neutral-800/60"
                                : "hover:bg-neutral-800/30"
                            }`}
                          >
                            <TypeIcon collection={result.collection} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <TypeBadge collection={result.collection} />
                                <span className="text-sm font-semibold text-neutral-100 truncate">
                                  {result.title}
                                </span>
                              </div>
                              {result.excerpt && (
                                <p
                                  className="mt-1 text-xs text-neutral-400 leading-relaxed line-clamp-2 search-excerpt"
                                  dangerouslySetInnerHTML={{
                                    __html: result.excerpt,
                                  }}
                                />
                              )}
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {totalFound > results.length && (
                      <div className="px-4 py-2 text-center font-mono text-[10px] text-neutral-600 border-t border-neutral-800/50">
                        showing {results.length} of {totalFound} results
                      </div>
                    )}
                  </>
                ) : loading ? (
                  <div className="py-12 text-center">
                    <div className="inline-flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-neutral-600 animate-pulse" />
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-neutral-600 animate-pulse"
                        style={{ animationDelay: "150ms" }}
                      />
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-neutral-600 animate-pulse"
                        style={{ animationDelay: "300ms" }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="py-12 text-center text-sm text-neutral-500">
                    No results for &ldquo;{query}&rdquo;
                  </div>
                )}
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-neutral-600">
                Start typing to search across all content
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-center gap-4 px-4 py-2.5 border-t border-neutral-800 text-[10px] text-neutral-600 font-mono">
              <span>
                <kbd>↑↓</kbd> navigate
              </span>
              <span>
                <kbd>↵</kbd> select
              </span>
              <span>
                <kbd>esc</kbd> close
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
