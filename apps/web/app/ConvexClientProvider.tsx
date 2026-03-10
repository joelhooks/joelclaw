"use client";

import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";
import { type ReactNode, useRef } from "react";
import { authClient } from "@/lib/auth-client";

function useConvexClient() {
  const ref = useRef<ConvexReactClient | null>(null);
  const url = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!url) return null;

  if (!ref.current) {
    ref.current = new ConvexReactClient(url);
  }
  return ref.current;
}

export function ConvexClientProvider({
  children,
  initialToken,
}: {
  children: ReactNode;
  initialToken?: string | null;
}) {
  const convex = useConvexClient();
  if (!convex) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-700/50 p-4 text-sm text-neutral-500">
        Set NEXT_PUBLIC_CONVEX_URL to render this Convex-backed view.
      </div>
    );
  }

  return (
    <ConvexBetterAuthProvider
      client={convex}
      authClient={authClient}
      initialToken={initialToken}
    >
      {children}
    </ConvexBetterAuthProvider>
  );
}
