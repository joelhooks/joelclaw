export default function MemoryLoading() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <div className="space-y-2">
        <p className="font-pixel text-[11px] uppercase tracking-[0.15em] text-neutral-500">
          loading memory
        </p>
        <div className="h-7 w-52 animate-pulse rounded bg-neutral-800/50" />
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="h-10 min-w-[200px] flex-1 animate-pulse rounded bg-neutral-800/50" />
        <div className="flex gap-1">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-8 w-20 animate-pulse rounded bg-neutral-800/50" />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="rounded-lg border border-neutral-700/30 bg-neutral-900/30 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="h-4 w-24 animate-pulse rounded bg-neutral-800/50" />
              <div className="h-3 w-20 animate-pulse rounded bg-neutral-800/50" />
              <div className="ml-auto h-3 w-36 animate-pulse rounded bg-neutral-800/50" />
            </div>
            <div className="space-y-2">
              <div className="h-4 w-full animate-pulse rounded bg-neutral-800/50" />
              <div className="h-4 w-10/12 animate-pulse rounded bg-neutral-800/50" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
