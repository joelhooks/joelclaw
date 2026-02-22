import { Suspense } from "react";
import { ConvexClientProvider } from "../ConvexClientProvider";

export default function ConvexRouteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <Suspense
      fallback={
        <div className="rounded-lg border border-neutral-800/40 p-4 text-sm text-neutral-500">
          Loading authenticated view...
        </div>
      }
    >
      <ConvexClientProvider>{children}</ConvexClientProvider>
    </Suspense>
  );
}
