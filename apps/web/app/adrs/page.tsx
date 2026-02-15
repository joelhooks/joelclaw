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
  { color: string; bg: string; border: string; glow: string }
> = {
  accepted: {
    color: "text-green-400",
    bg: "bg-green-950/40",
    border: "border-green-800/50",
    glow: "shadow-[0_0_8px_rgba(74,222,128,0.25)]",
  },
  proposed: {
    color: "text-yellow-400",
    bg: "bg-yellow-950/30",
    border: "border-yellow-800/50",
    glow: "shadow-[0_0_8px_rgba(250,204,21,0.25)]",
  },
  superseded: {
    color: "text-neutral-500",
    bg: "bg-neutral-900/40",
    border: "border-neutral-700/50",
    glow: "shadow-[0_0_8px_rgba(163,163,163,0.15)]",
  },
  implemented: {
    color: "text-claw",
    bg: "bg-pink-950/20",
    border: "border-pink-800/40",
    glow: "shadow-[0_0_8px_rgba(255,20,147,0.3)]",
  },
  deprecated: {
    color: "text-red-400",
    bg: "bg-red-950/30",
    border: "border-red-800/50",
    glow: "shadow-[0_0_8px_rgba(248,113,113,0.25)]",
  },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.proposed!;
  return (
    <span
      className={`inline-flex text-[10px] font-medium uppercase tracking-widest border rounded-sm px-2 py-0.5 ${cfg.color} ${cfg.bg} ${cfg.border}`}
    >
      {status}
    </span>
  );
}

function StatusFilter({
  status,
  count,
  active,
}: {
  status: string;
  count: number;
  active: boolean;
}) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.proposed!;
  const href = active ? "/adrs" : `/adrs?status=${status}`;

  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-all ${
        active
          ? `${cfg.color} ${cfg.bg} ${cfg.border} ${cfg.glow}`
          : `text-neutral-500 border-neutral-800 hover:${cfg.color} hover:border-neutral-600`
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${active ? "bg-current" : cfg.bg} ${cfg.border} border`}
      />
      <span className="tabular-nums">{count}</span>
      <span>{status}</span>
    </Link>
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
            <h2
              className={`text-base font-medium tracking-tight group-hover:text-white transition-colors ${isSuperseded ? "line-through decoration-neutral-600" : ""}`}
            >
              {adr.title}
            </h2>
            {adr.description && (
              <p className="mt-1.5 text-sm text-neutral-500 leading-relaxed line-clamp-2">
                {adr.description}
              </p>
            )}
            <div className="mt-2 flex items-center gap-3">
              <StatusBadge status={adr.status} />
              <time className="text-xs text-neutral-600 tabular-nums">
                {formatDate(adr.date)}
              </time>
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}

type Props = {
  searchParams: Promise<{ status?: string }>;
};

export default async function AdrsPage({ searchParams }: Props) {
  const { status: filterStatus } = await searchParams;
  const allAdrs = getAllAdrs();

  const counts = allAdrs.reduce(
    (acc, a) => {
      acc[a.status] = (acc[a.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const adrs = filterStatus
    ? allAdrs.filter((a) => a.status === filterStatus)
    : allAdrs;

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
        <div className="mt-4 flex flex-wrap gap-2">
          {Object.entries(counts)
            .sort(([, a], [, b]) => b - a)
            .map(([status, count]) => (
              <StatusFilter
                key={status}
                status={status}
                count={count}
                active={filterStatus === status}
              />
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
