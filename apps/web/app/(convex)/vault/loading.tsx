export default function VaultLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <p className="font-pixel text-[11px] uppercase tracking-[0.15em] text-neutral-500">
          loading vault
        </p>
        <div className="h-3 w-28 animate-pulse rounded bg-neutral-800/50" />
      </div>

      <div className="space-y-4 rounded-lg border border-neutral-700/30 bg-neutral-900/20 p-4">
        {Array.from({ length: 4 }).map((_, sectionIndex) => (
          <div key={sectionIndex} className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="h-5 w-5 animate-pulse rounded bg-neutral-800/50" />
              <div className="h-5 w-24 animate-pulse rounded bg-neutral-800/50" />
              <div className="h-4 w-8 animate-pulse rounded bg-neutral-800/50" />
            </div>
            <div className="ml-6 space-y-2 border-l border-neutral-700/30 pl-3">
              {Array.from({ length: 3 }).map((_, noteIndex) => (
                <div
                  key={noteIndex}
                  className="h-7 w-full animate-pulse rounded bg-neutral-800/50"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
