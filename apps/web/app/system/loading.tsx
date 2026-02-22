export default function SystemLoading() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <div className="space-y-2">
        <p className="font-pixel text-[11px] uppercase tracking-[0.15em] text-neutral-500">
          loading observability
        </p>
        <div className="h-7 w-72 animate-pulse rounded bg-neutral-800/50" />
        <div className="h-4 w-[32rem] max-w-full animate-pulse rounded bg-neutral-800/50" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-2 rounded-lg border border-neutral-700/30 bg-neutral-900/20 p-4">
            <div className="h-3 w-24 animate-pulse rounded bg-neutral-800/50" />
            <div className="h-7 w-20 animate-pulse rounded bg-neutral-800/50" />
          </div>
        ))}
      </div>

      <section className="space-y-3">
        <div className="flex gap-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-7 w-28 animate-pulse rounded bg-neutral-800/50" />
          ))}
        </div>

        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-14 w-full animate-pulse rounded-lg bg-neutral-800/50" />
          ))}
        </div>
      </section>
    </div>
  );
}
