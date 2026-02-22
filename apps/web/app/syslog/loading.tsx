export default function SyslogLoading() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="space-y-2">
        <p className="font-pixel text-[11px] uppercase tracking-[0.15em] text-neutral-500">
          loading system log
        </p>
        <div className="h-7 w-56 animate-pulse rounded bg-neutral-800/50" />
      </div>

      <div className="h-10 w-full animate-pulse rounded bg-neutral-800/50" />

      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="h-7 w-20 animate-pulse rounded bg-neutral-800/50" />
        ))}
      </div>

      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-16 w-full animate-pulse rounded-lg bg-neutral-800/50" />
        ))}
      </div>
    </div>
  );
}
