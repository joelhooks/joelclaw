import Link from "next/link";
import type { Metadata } from "next";
import { getAllAdrs, type AdrMeta } from "../../lib/adrs";
import { SITE_NAME } from "../../lib/constants";

export const metadata: Metadata = {
  title: `ADRs — ${SITE_NAME}`,
  description:
    "Architecture Decision Records — how this system is built and why.",
};

const STATUS_CONFIG: Record<
  string,
  { color: string; bg: string; border: string }
> = {
  accepted: {
    color: "text-green-400",
    bg: "bg-green-950/40",
    border: "border-green-800/50",
  },
  proposed: {
    color: "text-yellow-400",
    bg: "bg-yellow-950/30",
    border: "border-yellow-800/50",
  },
  superseded: {
    color: "text-neutral-500",
    bg: "bg-neutral-900/40",
    border: "border-neutral-700/50",
  },
  implemented: {
    color: "text-claw",
    bg: "bg-pink-950/20",
    border: "border-pink-800/40",
  },
  deprecated: {
    color: "text-red-400",
    bg: "bg-red-950/30",
    border: "border-red-800/50",
  },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.proposed;
  return (
    <span
      className={`inline-flex text-[10px] font-medium uppercase tracking-widest border rounded-sm px-2 py-0.5 ${cfg.color} ${cfg.bg} ${cfg.border}`}
    >
      {status}
    </span>
  );
}

function formatDate(dateStr: string) {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function AdrRow({ adr }: { adr: AdrMeta }) {
  const isSuperseded = adr.status === "superseded";

  return (
    <li
      className={`group border-b border-neutral-800/50 last:border-0 ${isSuperseded ? "opacity-50" : ""}`}
    >
      <Link href={`/adrs/${adr.slug}`} className="block py-4 sm:py-5">
        <div className="flex items-start gap-4">
          <span className="shrink-0 font-mono text-xs text-neutral-600 pt-1 tabular-nums">
            {adr.number.padStart(4, "0")}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h2
                className={`text-base font-medium tracking-tight group-hover:text-white transition-colors ${isSuperseded ? "line-through decoration-neutral-600" : ""}`}
              >
                {adr.title}
              </h2>
              <StatusBadge status={adr.status} />
            </div>
            {adr.description && (
              <p className="mt-1 text-sm text-neutral-500 leading-relaxed line-clamp-2">
                {adr.description}
              </p>
            )}
          </div>
          <time className="shrink-0 text-xs text-neutral-600 pt-1 tabular-nums hidden sm:block">
            {formatDate(adr.date)}
          </time>
        </div>
      </Link>
    </li>
  );
}

export default function AdrsPage() {
  const adrs = getAllAdrs();
  const counts = adrs.reduce(
    (acc, a) => {
      acc[a.status] = (acc[a.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <>
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">
          Architecture Decision Records
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          How this system is built and why. Every decision that changes the
          architecture gets written down.
        </p>
        <div className="mt-4 flex gap-4 text-xs text-neutral-500">
          {Object.entries(counts)
            .sort(([, a], [, b]) => b - a)
            .map(([status, count]) => (
              <span key={status} className="flex items-center gap-1.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${STATUS_CONFIG[status]?.bg ?? "bg-neutral-700"} ${STATUS_CONFIG[status]?.border ?? ""} border`}
                />
                {count} {status}
              </span>
            ))}
        </div>
      </header>
      <ul className="border-t border-neutral-800/50">
        {adrs.map((adr) => (
          <AdrRow key={adr.slug} adr={adr} />
        ))}
      </ul>
    </>
  );
}
