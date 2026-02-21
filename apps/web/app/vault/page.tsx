"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

// ── Types ───────────────────────────────────────────────────────

interface VaultNote {
  title: string;
  path: string;
  type?: string;
  tags?: string[];
}

interface NoteContent extends VaultNote {
  content: string;
}

// ── Section colors ──────────────────────────────────────────────

const SECTION_STYLES: Record<string, { color: string; bg: string }> = {
  Projects: { color: "text-claw", bg: "bg-claw/10" },
  Resources: { color: "text-blue-400", bg: "bg-blue-500/10" },
  Areas: { color: "text-emerald-400", bg: "bg-emerald-500/10" },
  Archive: { color: "text-neutral-500", bg: "bg-neutral-500/10" },
  Daily: { color: "text-amber-400", bg: "bg-amber-500/10" },
  docs: { color: "text-purple-400", bg: "bg-purple-500/10" },
  system: { color: "text-cyan-400", bg: "bg-cyan-500/10" },
  inbox: { color: "text-orange-400", bg: "bg-orange-500/10" },
};

function sectionStyle(section: string) {
  return SECTION_STYLES[section] || { color: "text-neutral-400", bg: "bg-neutral-500/10" };
}

// ── Search ──────────────────────────────────────────────────────

function VaultSearch({
  onSelect,
}: {
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { title: string; path: string; snippet: string }[]
  >([]);
  const [searching, setSearching] = useState(false);

  const search = useCallback(async () => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const resp = await fetch(`/api/vault?q=${encodeURIComponent(query)}`);
      const data = await resp.json();
      setResults(data.hits || []);
    } catch {
      setResults([]);
    }
    setSearching(false);
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(search, 300);
    return () => clearTimeout(timer);
  }, [query, search]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search vault..."
          className="w-full rounded-lg border border-neutral-700/50 bg-neutral-950 px-4 py-2.5 pl-8 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 transition-colors focus:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
        />
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-neutral-600">
          /
        </span>
        {searching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-neutral-700 border-t-claw" />
          </span>
        )}
      </div>
      {results.length > 0 && (
        <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-neutral-700/30 bg-neutral-900/50 p-1">
          {results.map((r) => (
            <button
              key={r.path}
              onClick={() => {
                onSelect(r.path);
                setQuery("");
                setResults([]);
              }}
              className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-neutral-800/50"
            >
              <span className="font-mono text-xs text-neutral-200">
                {r.title}
              </span>
              {r.snippet && (
                <span
                  className="font-mono text-[10px] text-neutral-500 [&_mark]:bg-transparent [&_mark]:text-claw"
                  dangerouslySetInnerHTML={{ __html: r.snippet }}
                />
              )}
              <span className="font-mono text-[10px] text-neutral-600">
                {r.path}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tree sidebar ────────────────────────────────────────────────

function VaultTree({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: Record<string, VaultNote[]>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (section: string) =>
    setExpanded((prev) => ({ ...prev, [section]: !prev[section] }));

  const sections = Object.keys(tree).sort((a, b) => {
    // PARA order: Projects, Areas, Resources, Archive, then rest
    const order = ["Projects", "Areas", "Resources", "Archive"];
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-1">
      {sections.map((section) => {
        const style = sectionStyle(section);
        const notes = tree[section];
        const isOpen = expanded[section] ?? false;

        return (
          <div key={section}>
            <button
              onClick={() => toggle(section)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-neutral-800/40"
            >
              <span className="font-mono text-[10px] text-neutral-600">
                {isOpen ? "▼" : "▶"}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 font-pixel text-[10px] uppercase tracking-wider ${style.color} ${style.bg}`}
              >
                {section}
              </span>
              <span className="font-mono text-[10px] text-neutral-600">
                {notes.length}
              </span>
            </button>
            {isOpen && (
              <div className="ml-4 space-y-0.5 border-l border-neutral-800/50 pl-3">
                {notes.map((note) => (
                  <button
                    key={note.path}
                    onClick={() => onSelect(note.path)}
                    className={`block w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs transition-colors hover:bg-neutral-800/40 ${
                      selectedPath === note.path
                        ? "bg-neutral-800/60 text-neutral-100"
                        : "text-neutral-400"
                    }`}
                  >
                    {note.title || note.path.split("/").pop()?.replace(".md", "")}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Note viewer ─────────────────────────────────────────────────

function NoteViewer({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const [note, setNote] = useState<NoteContent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/vault?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setNote(null);
        } else {
          setNote(data);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [path]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-700 border-t-claw" />
      </div>
    );
  }

  if (!note) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-700/50 p-8 text-center">
        <p className="font-mono text-xs text-neutral-500">note not found</p>
        <p className="mt-1 font-mono text-[10px] text-neutral-600">{path}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Note header */}
      <div className="flex items-start justify-between border-b border-neutral-700/40 pb-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="font-mono text-base font-medium text-neutral-100">
            {note.title}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-neutral-500">
              {note.path}
            </span>
            {note.type && (
              <span className="rounded bg-neutral-800/60 px-1.5 py-0.5 font-pixel text-[9px] uppercase tracking-wider text-neutral-400">
                {note.type}
              </span>
            )}
          </div>
          {note.tags && note.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {note.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-claw/8 px-2 py-0.5 font-mono text-[10px] text-claw/70"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md px-2 py-1 font-mono text-xs text-neutral-500 transition-colors hover:bg-neutral-800/40 hover:text-neutral-300"
        >
          ✕
        </button>
      </div>

      {/* Note content — rendered as preformatted markdown */}
      <div className="prose-vault max-h-[70vh] overflow-y-auto rounded-lg border border-neutral-800/30 bg-neutral-950/50 p-4 font-mono text-sm leading-relaxed text-neutral-300">
        <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.7]">
          {note.content}
        </pre>
      </div>
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────

export default function VaultPage() {
  const [tree, setTree] = useState<Record<string, VaultNote[]> | null>(null);
  const [total, setTotal] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/vault")
      .then((r) => r.json())
      .then((data) => {
        setTree(data.tree || {});
        setTotal(data.total || 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-700/40 pb-4">
        <div className="flex items-center gap-3">
          <span className="font-mono text-lg">📂</span>
          <h1 className="font-pixel text-sm uppercase tracking-[0.12em] text-neutral-300">
            Vault
          </h1>
          <span className="font-mono text-[11px] text-neutral-500">
            {total} notes
          </span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] text-neutral-500">
          <Link href="/dashboard" className="transition-colors hover:text-neutral-300">
            ← system
          </Link>
          <span className="text-neutral-600">|</span>
          <Link href="/" className="transition-colors hover:text-neutral-300">
            site
          </Link>
        </div>
      </div>

      {/* Search */}
      <VaultSearch onSelect={setSelectedPath} />

      {/* Content area */}
      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        {/* Sidebar — tree */}
        <div className="max-h-[80vh] overflow-y-auto rounded-lg border border-neutral-700/30 bg-neutral-900/20 p-3">
          {loading ? (
            <div className="space-y-2">
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="h-6 animate-pulse rounded bg-neutral-800/30"
                />
              ))}
            </div>
          ) : tree ? (
            <VaultTree
              tree={tree}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
            />
          ) : (
            <p className="font-mono text-xs text-neutral-600">
              failed to load vault
            </p>
          )}
        </div>

        {/* Main — note viewer */}
        <div className="min-h-[400px]">
          {selectedPath ? (
            <NoteViewer
              path={selectedPath}
              onClose={() => setSelectedPath(null)}
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-neutral-700/30 p-12">
              <div className="text-center space-y-2">
                <p className="font-mono text-sm text-neutral-500">
                  select a note or search
                </p>
                <p className="font-mono text-[10px] text-neutral-600">
                  PARA structure · markdown content · owner-only
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
