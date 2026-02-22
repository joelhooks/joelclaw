export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <div className="space-y-2">
        <p className="font-pixel text-[11px] uppercase tracking-[0.15em] text-neutral-500">
          loading dashboard
        </p>
        <div className="h-7 w-44 animate-pulse rounded bg-neutral-800/50" />
      </div>

      <div className="grid gap-3 border-b border-neutral-700/40 pb-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-2 rounded-lg border border-neutral-700/30 bg-neutral-900/20 p-4">
            <div className="h-3 w-20 animate-pulse rounded bg-neutral-800/50" />
            <div className="h-7 w-16 animate-pulse rounded bg-neutral-800/50" />
          </div>
        ))}
      </div>

      <div className="space-y-4 rounded-lg border border-neutral-700/30 bg-neutral-900/20 p-4">
        <div className="h-10 w-full animate-pulse rounded bg-neutral-800/50" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-16 w-full animate-pulse rounded-lg bg-neutral-800/50" />
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-neutral-700/30 bg-neutral-900/20 p-4">
          <div className="flex items-center gap-2">
            <div className="h-3 w-24 animate-pulse rounded bg-neutral-800/50" />
            <div className="h-px flex-1 bg-neutral-700/40" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-lg bg-neutral-800/50" />
            ))}
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-neutral-700/30 bg-neutral-900/20 p-4">
          <div className="flex items-center gap-2">
            <div className="h-3 w-20 animate-pulse rounded bg-neutral-800/50" />
            <div className="h-px flex-1 bg-neutral-700/40" />
          </div>
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded bg-neutral-800/50" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
