"use client";

import { PageHeader } from "@repo/ui/page-header";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { api } from "@/lib/convex-api";

export default function MemoryPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const isOwner = useQuery(api.auth.isOwner);

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
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Memory" />
      <section className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-neutral-100">Legacy observation browser retired</h2>
        <p className="text-sm leading-6 text-neutral-400">
          Operational memory now comes from accepted Runs projected into flowing reflections and
          observations. Durable curated knowledge remains in Brain. This page no longer reads the
          retired observation collection.
        </p>
        <div className="rounded border border-neutral-800 bg-black/30 p-4 font-mono text-xs text-neutral-300 space-y-2">
          <p>joelclaw recall &lt;query&gt;</p>
          <p>joelclaw memory review --since 48h</p>
          <p>joelclaw sessions search &lt;query&gt; --raw</p>
        </div>
      </section>
    </div>
  );
}
