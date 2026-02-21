"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { authClient } from "../../lib/auth-client";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Tree uses Link for navigation to full note pages

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

// PARA sort order
const SECTION_ORDER = ["Projects", "Areas", "Resources", "Archive"];
function sectionSort(a: string, b: string) {
  const ai = SECTION_ORDER.indexOf(a);
  const bi = SECTION_ORDER.indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

// ── Tree sidebar ────────────────────────────────────────────────

function VaultTree({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: Record<string, { path: string; title: string; type: string; tags: string[] }[]>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (s: string) => setExpanded((p) => ({ ...p, [s]: !p[s] }));

  const sections = Object.keys(tree).sort(sectionSort);

  return (
    <div className="space-y-1">
      {sections.map((section) => {
        const style = sectionStyle(section);
        const notes = tree[section]!;
        const isOpen = expanded[section] ?? false;

        return (
          <div key={section}>
            <button
              onClick={() => toggle(section)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-neutral-800/40"
            >
              <span className="font-mono text-xs text-neutral-500">
                {isOpen ? "▼" : "▶"}
              </span>
              <span className={`rounded px-1.5 py-0.5 font-pixel text-xs uppercase tracking-wider ${style.color} ${style.bg}`}>
                {section}
              </span>
              <span className="font-mono text-xs text-neutral-500">
                {notes.length}
              </span>
            </button>
            {isOpen && (
              <div className="ml-4 space-y-0.5 border-l border-neutral-700/30 pl-3">
                {notes.map((note) => (
                  <Link
                    key={note.path}
                    href={`/vault/${note.path}`}
                    className={`block w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-sm transition-colors hover:bg-neutral-800/40 ${
                      selectedPath === note.path
                        ? "bg-neutral-800/60 text-neutral-100"
                        : "text-neutral-400"
                    }`}
                  >
                    {note.title}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────

export default function VaultPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const isOwner = useQuery(api.auth.isOwner);
  const data = useQuery(api.vaultNotes.listBySection);

  // Auth gate
  if (isPending || isOwner === undefined) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-neutral-700 border-t-claw" />
      </div>
    );
  }
  if (!session?.user || !isOwner) {
    router.replace("/");
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      {data && (
        <div className="font-mono text-sm text-neutral-500">
          {data.total} notes · {Object.keys(data.tree).length} sections
        </div>
      )}

      {/* Tree browser — full width, notes link to /vault/{path} */}
      <div className="overflow-y-auto rounded-lg border border-neutral-700/30 bg-neutral-900/20 p-4">
        {!data ? (
          <div className="space-y-2">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-7 animate-pulse rounded bg-neutral-800/30" />
            ))}
          </div>
        ) : (
          <VaultTree tree={data.tree} selectedPath={null} onSelect={() => {}} />
        )}
      </div>
    </div>
  );
}
