"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { authClient } from "../../lib/auth-client";
import { Mic } from "lucide-react";

type Transcript = {
  id: string;
  content: string;
  room: string;
  turns: number;
  timestamp: number;
};

export default function VoicePage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const isOwner = useQuery(api.auth.isOwner);
  const [data, setData] = useState<{ hits: Transcript[]; found: number } | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!isOwner) return;
    const q = query.trim() || "*";
    fetch(`/api/typesense/voice_transcripts?q=${encodeURIComponent(q)}&per_page=50`)
      .then((r) => r.json())
      .then((d) =>
        setData({
          hits: (d.hits || []).map((h: any) => ({ id: h.document.id, ...h.document })),
          found: d.found || 0,
        })
      )
      .catch(() => {});
  }, [isOwner, query]);

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
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Mic className="w-6 h-6 text-cyan-400" />
        <h1 className="font-mono text-xl font-bold text-neutral-100">Voice Transcripts</h1>
        {data && (
          <span className="font-mono text-sm text-neutral-500">
            {data.found} transcripts
          </span>
        )}
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search transcripts..."
        className="w-full rounded-lg border border-neutral-700/50 bg-neutral-950 px-4 py-2.5 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
      />

      {data?.found === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-700/40 p-8 text-center">
          <p className="font-mono text-sm text-neutral-500">no voice transcripts yet</p>
          <p className="mt-1 font-mono text-[10px] text-neutral-600">
            transcripts appear here after voice agent conversations
          </p>
        </div>
      )}

      <div className="space-y-3">
        {data?.hits.map((t) => (
          <div
            key={t.id}
            className="rounded-lg border border-neutral-700/30 bg-neutral-900/30 p-4 space-y-2"
          >
            <div className="flex items-center gap-2">
              <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 font-pixel text-[10px] text-cyan-400 uppercase tracking-wider">
                {t.room}
              </span>
              <span className="font-mono text-[10px] text-neutral-500">
                {t.turns} turns
              </span>
              <span className="ml-auto font-mono text-[10px] text-neutral-600">
                {new Date(t.timestamp * 1000).toLocaleString()}
              </span>
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-neutral-300">
              {t.content}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
