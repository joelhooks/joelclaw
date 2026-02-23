/**
 * Dashboard layout — static shell, auth checked client-side.
 * Full route cache: this layout is pre-rendered at build time.
 */
import Link from "next/link";
import { SITE_COPYRIGHT_YEAR } from "@/lib/constants";
import { StatusPulseDot } from "@repo/ui/status-badge";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      {/* Dashboard header */}
      <div className="flex items-center justify-between border-b border-neutral-700/50 pb-4">
        <div className="flex items-center gap-3">
          <StatusPulseDot status="healthy" label="System Dashboard status: healthy" />
          <h1 className="font-pixel text-sm uppercase tracking-[0.12em] text-neutral-300">System Dashboard</h1>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] text-neutral-500">
          <Link
            href="/"
            className="transition-colors hover:text-neutral-300"
          >
            ← site
          </Link>
          <span className="text-neutral-600">|</span>
          <span>{SITE_COPYRIGHT_YEAR}</span>
        </div>
      </div>
      {children}
    </div>
  );
}
