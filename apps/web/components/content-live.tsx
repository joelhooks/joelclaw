"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { api } from "@/convex/_generated/api";

/**
 * Invisible island that subscribes to a Convex content resource's hash.
 * When the hash changes (content updated), triggers router.refresh()
 * to re-render the server component with fresh data.
 *
 * Drop this anywhere inside a page — it renders nothing visible.
 */
export function ContentLive({ resourceId }: { resourceId: string }) {
  const router = useRouter();
  const data = useQuery(api.contentResources.getContentHash, { resourceId });
  const prevHash = useRef<string | undefined>(undefined);
  const initialized = useRef(false);

  useEffect(() => {
    if (!data) return;

    const hash = data.contentHash ?? String(data.updatedAt);

    if (!initialized.current) {
      // First load — just record the hash, don't refresh
      prevHash.current = hash;
      initialized.current = true;
      return;
    }

    if (prevHash.current && hash !== prevHash.current) {
      prevHash.current = hash;
      router.refresh();
    }
  }, [data, router]);

  return null;
}
