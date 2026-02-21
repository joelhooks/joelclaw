"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { authClient } from "../../../lib/auth-client";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";

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

export default function VaultNotePage() {
  const router = useRouter();
  const params = useParams();
  const { data: session, isPending } = authClient.useSession();
  const isOwner = useQuery(api.auth.isOwner);

  // Reconstruct the vault path from URL segments
  const pathSegments = params.path as string[];
  const vaultPath = pathSegments.join("/");

  const resource = useQuery(api.contentResources.getByResourceId, {
    resourceId: `vault:${vaultPath}`,
  });

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

  // Loading
  if (resource === undefined) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-neutral-700 border-t-claw" />
      </div>
    );
  }

  // Not found
  if (!resource) {
    return (
      <div className="space-y-6">
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/vault" className="text-neutral-500 transition-colors hover:text-neutral-300">
            ← vault
          </Link>
        </nav>
        <div className="rounded-lg border border-dashed border-neutral-700/50 p-12 text-center">
          <p className="font-mono text-base text-neutral-500">note not found</p>
          <p className="mt-2 font-mono text-sm text-neutral-600">{vaultPath}</p>
        </div>
      </div>
    );
  }

  const fields = (resource.fields ?? {}) as Record<string, unknown>;
  const note = {
    title: String(fields.title ?? "untitled"),
    section: String(fields.section ?? vaultPath.split("/")[0] ?? ""),
    type: String(fields.type ?? "note"),
    tags: Array.isArray(fields.tags) ? fields.tags.map((tag) => String(tag)) : [],
    html: typeof fields.html === "string" ? fields.html : undefined,
    content: String(fields.content ?? ""),
  };

  const style = sectionStyle(note.section);

  // Breadcrumb from path
  const crumbs = vaultPath.split("/");

  return (
    <div className="space-y-6">
      {/* Breadcrumb nav */}
      <nav className="flex flex-wrap items-center gap-1.5 text-sm">
        <Link href="/vault" className="text-neutral-500 transition-colors hover:text-neutral-300">
          vault
        </Link>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          const partialPath = crumbs.slice(0, i + 1).join("/");
          return (
            <span key={i} className="flex items-center gap-1.5">
              <span className="text-neutral-700">/</span>
              {isLast ? (
                <span className="text-neutral-200">{crumb.replace(".md", "")}</span>
              ) : (
                <Link
                  href={`/vault?section=${encodeURIComponent(partialPath)}`}
                  className="text-neutral-500 transition-colors hover:text-neutral-300"
                >
                  {crumb}
                </Link>
              )}
            </span>
          );
        })}
      </nav>

      {/* Note header */}
      <div className="border-b border-neutral-700/40 pb-4">
        <h1 className="text-xl font-semibold text-neutral-100 sm:text-2xl">
          {note.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 font-pixel text-[10px] uppercase tracking-wider ${style.color} ${style.bg}`}>
            {note.section}
          </span>
          <span className="rounded bg-neutral-800/60 px-1.5 py-0.5 font-pixel text-[10px] uppercase tracking-wider text-neutral-400">
            {note.type}
          </span>
          <span className="font-mono text-xs text-neutral-600">
            {vaultPath}
          </span>
        </div>
        {note.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {note.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-claw/10 px-2.5 py-0.5 font-mono text-xs text-claw/70">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <article className="pb-16">
        {note.html ? (
          <div
            className="vault-prose"
            dangerouslySetInnerHTML={{ __html: note.html }}
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-[1.8] text-neutral-300">
            {note.content}
          </pre>
        )}
      </article>
    </div>
  );
}
