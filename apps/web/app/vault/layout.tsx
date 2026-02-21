"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Section colors
const SECTION_STYLES: Record<string, { color: string; bg: string }> = {
  Projects: { color: "text-claw", bg: "bg-claw/10" },
  Resources: { color: "text-blue-400", bg: "bg-blue-500/10" },
  Areas: { color: "text-emerald-400", bg: "bg-emerald-500/10" },
  docs: { color: "text-purple-400", bg: "bg-purple-500/10" },
  system: { color: "text-cyan-400", bg: "bg-cyan-500/10" },
};
function sectionStyle(s: string) {
  return SECTION_STYLES[s] || { color: "text-neutral-400", bg: "bg-neutral-500/10" };
}

function VaultSearchBar() {
  const [query, setQuery] = useState("");
  const results = useQuery(
    api.vaultNotes.search,
    query.trim().length > 1 ? { query: query.trim() } : "skip"
  );
  const router = useRouter();

  return (
    <div className="relative">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search vault..."
          className="w-full rounded-lg border border-neutral-700/50 bg-neutral-950 px-4 py-2 pl-8 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 transition-colors focus:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
        />
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-neutral-600">
          /
        </span>
      </div>
      {results && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-neutral-700/30 bg-neutral-900 p-1 shadow-xl">
          {results.map((r) => {
            const style = sectionStyle(r.section);
            return (
              <button
                key={r.path}
                onClick={() => {
                  router.push(`/vault/${r.path}`);
                  setQuery("");
                }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-neutral-800/60"
              >
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-pixel text-[10px] uppercase tracking-wider ${style.color} ${style.bg}`}>
                  {r.section}
                </span>
                <span className="truncate font-mono text-sm text-neutral-200">
                  {r.title}
                </span>
                <span className="ml-auto shrink-0 rounded bg-neutral-800/50 px-1.5 py-0.5 font-pixel text-[10px] text-neutral-500">
                  {r.type}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function VaultLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      {/* Vault header */}
      <div className="flex items-center justify-between border-b border-neutral-700/40 pb-4">
        <div className="flex items-center gap-3">
          <Link href="/vault" className="flex items-center gap-3 transition-colors hover:opacity-80">
            <span className="text-xl">📂</span>
            <h1 className="font-pixel text-base uppercase tracking-[0.12em] text-neutral-300">
              Vault
            </h1>
          </Link>
        </div>
        <div className="flex items-center gap-4 font-mono text-xs text-neutral-500">
          <Link href="/dashboard" className="transition-colors hover:text-neutral-300">
            ← system
          </Link>
          <span className="text-neutral-600">|</span>
          <Link href="/" className="transition-colors hover:text-neutral-300">
            site
          </Link>
        </div>
      </div>

      {/* Persistent search */}
      <VaultSearchBar />

      {/* Page content */}
      {children}
    </div>
  );
}
