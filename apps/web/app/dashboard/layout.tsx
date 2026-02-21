import { isAuthenticated, fetchAuthQuery } from "../../lib/auth-server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { api } from "../../convex/_generated/api";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const authed = await isAuthenticated();
  if (!authed) {
    redirect("/signin");
  }

  // Only Joel (GitHub ID 86834) gets past this gate
  const isOwner = await fetchAuthQuery(api.auth.isOwner);
  if (!isOwner) {
    redirect("/");
  }

  return (
    <div className="space-y-8">
      {/* Dashboard header */}
      <div className="flex items-center justify-between border-b border-neutral-800/60 pb-4">
        <div className="flex items-center gap-3">
          <div className="h-2 w-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50 animate-pulse" />
          <h1 className="font-pixel text-sm uppercase tracking-[0.12em] text-neutral-400">
            System Dashboard
          </h1>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] text-neutral-600">
          <Link
            href="/"
            className="transition-colors hover:text-neutral-400"
          >
            ← site
          </Link>
          <span className="text-neutral-800">|</span>
          <span suppressHydrationWarning>
            {new Date().toISOString().slice(0, 10)}
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}
