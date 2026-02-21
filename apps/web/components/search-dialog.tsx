"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X, FileText, GitBranch, Sparkles, BookOpen } from "lucide-react";
import { authClient } from "../lib/auth-client";

type PagefindResultData = {
  url: string;
  meta: Record<string, string>;
  excerpt: string;
};

type SearchResult = {
  url: string;
  title: string;
  excerpt: string;
  type: string;
};

function inferType(url: string): string {
  if (url.startsWith("/vault/")) return "vault";
  if (url.startsWith("/adrs/")) return "ADR";
  if (url.startsWith("/cool/")) return "discovery";
  return "article";
}

function TypeIcon({ type }: { type: string }) {
  const base = "w-4 h-4 mt-0.5 shrink-0";
  switch (type.toLowerCase()) {
    case "vault":
      return <BookOpen className={`${base} text-emerald-400`} />;
    case "adr":
      return <GitBranch className={`${base} text-blue-400`} />;
    case "discovery":
      return <Sparkles className={`${base} text-purple-400`} />;
    default:
      return <FileText className={`${base} text-claw`} />;
  }
}

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    vault: "text-emerald-400 border-emerald-800",
    adr: "text-blue-400 border-blue-800",
    discovery: "text-purple-400 border-purple-800",
    article: "text-claw border-pink-800",
    essay: "text-green-400 border-green-800",
    note: "text-yellow-400 border-yellow-800",
    tutorial: "text-orange-400 border-orange-800",
  };
  const color =
    colors[type.toLowerCase()] ?? "text-neutral-500 border-neutral-700";

  return (
    <span
      className={`shrink-0 text-[9px] font-medium uppercase tracking-wider border rounded px-1 py-0.5 ${color}`}
    >
      {type}
    </span>
  );
}

export function SearchDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pagefindRef = useRef<any>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const isAuthed = !!session?.user;

  // Load pagefind lazily on first open
  useEffect(() => {
    if (!open) return;
    async function load() {
      if (pagefindRef.current) return;
      try {
        // Dynamic path prevents TS from resolving as a module
        const pagefindPath = "/_next/static/pagefind/pagefind.js";
        pagefindRef.current = await import(
          /* webpackIgnore: true */ pagefindPath
        );
      } catch {
        // Dev mode or pagefind not built yet
        pagefindRef.current = {
          search: async () => ({ results: [] }),
          debouncedSearch: async () => ({ results: [] }),
        };
      }
    }
    load();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

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

  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
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
    }
  }, [open]);

  // Search handler — Pagefind for public content + Typesense vault for authed users
  const handleSearch = useCallback(async (value: string) => {
    setQuery(value);
    setActiveIndex(0);

    if (!value.trim() || !pagefindRef.current) {
      setResults([]);
      return;
    }

    setLoading(true);
    try {
      // Pagefind: public content (blog, ADRs, discoveries)
      const pagefindPromise = (async () => {
        const search = await pagefindRef.current.debouncedSearch(value);
        if (!search) return [];
        return Promise.all(
          search.results.slice(0, 10).map(
            async (r: { data: () => Promise<PagefindResultData> }) => {
              const data = await r.data();
              const url =
                data.url
                  .replace(/\/page(\.html)?$/, "")
                  .replace(/\.html$/, "") || "/";
              return {
                url,
                title: data.meta?.title || "Untitled",
                excerpt: data.excerpt || "",
                type: data.meta?.type || inferType(url),
              };
            },
          ),
        );
      })();

      // Typesense vault: only for authenticated users
      const vaultPromise = isAuthed
        ? fetch(`/api/vault?q=${encodeURIComponent(value)}`)
            .then((r) => r.json())
            .then((data) =>
              (data.hits || []).slice(0, 5).map((h: any) => ({
                url: `/vault/${h.path}`,
                title: h.title,
                excerpt: h.snippet || "",
                type: "vault",
              }))
            )
            .catch(() => [])
        : Promise.resolve([]);

      const [pagefindResults, vaultResults] = await Promise.all([
        pagefindPromise,
        vaultPromise,
      ]);

      // Merge: vault results first, then pagefind
      setResults([...vaultResults, ...pagefindResults]);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [isAuthed]);

  const navigateTo = useCallback(
    (url: string) => {
      setOpen(false);
      router.push(url);
    },
    [router],
  );

  // Keyboard navigation within results
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
                placeholder={isAuthed ? "Search vault, articles, ADRs, discoveries…" : "Search articles, ADRs, discoveries…"}
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
                  <ul className="py-2">
                    {results.map((result, i) => (
                      <li key={result.url} data-result="">
                        <button
                          onClick={() => navigateTo(result.url)}
                          onMouseEnter={() => setActiveIndex(i)}
                          className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors cursor-pointer ${
                            i === activeIndex
                              ? "bg-neutral-800/60"
                              : "hover:bg-neutral-800/30"
                          }`}
                        >
                          <TypeIcon type={result.type} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <TypeBadge type={result.type} />
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
                            <span className="mt-1 block font-mono text-[10px] text-neutral-600 truncate">
                              {result.url}
                            </span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
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
