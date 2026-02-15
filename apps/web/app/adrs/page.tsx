import Link from "next/link";
import { getAllAdrs } from "../../lib/adrs";

const STATUS_COLORS: Record<string, string> = {
  accepted: "text-green-400 border-green-800",
  proposed: "text-yellow-400 border-yellow-800",
  superseded: "text-neutral-500 border-neutral-700",
  implemented: "text-blue-400 border-blue-800",
  deprecated: "text-red-400 border-red-800",
};

export default function AdrsPage() {
  const adrs = getAllAdrs();

  return (
    <>
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight">
          Architecture Decision Records
        </h1>
        <p className="mt-2 text-neutral-400">
          How this system is built and why. Every decision that changes the
          architecture gets written down.
        </p>
      </header>
      <ul className="space-y-4">
        {adrs.map((adr) => {
          const statusClass =
            STATUS_COLORS[adr.status] ?? "text-neutral-500 border-neutral-700";
          return (
            <li key={adr.slug}>
              <Link href={`/adrs/${adr.slug}`} className="group block">
                <div className="flex items-center gap-3">
                  <span className="shrink-0 font-mono text-sm text-neutral-500">
                    {adr.number.padStart(4, "0")}
                  </span>
                  <span
                    className={`shrink-0 text-[11px] font-medium uppercase tracking-wider border rounded px-1.5 py-0.5 ${statusClass}`}
                  >
                    {adr.status}
                  </span>
                  <h2 className="text-lg font-semibold tracking-tight group-hover:text-white transition-colors">
                    {adr.title}
                  </h2>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
