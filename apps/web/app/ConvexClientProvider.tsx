"use client";

import { ReactNode, useRef } from "react";
import { ConvexReactClient } from "convex/react";
import { authClient } from "@/lib/auth-client";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";

function useConvexClient() {
  const ref = useRef<ConvexReactClient | null>(null);
  if (!ref.current) {
    ref.current = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
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
