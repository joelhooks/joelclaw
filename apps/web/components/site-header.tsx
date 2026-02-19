"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CLAW_PATH } from "../lib/claw";
import { SITE_NAME, SITE_TAGLINE } from "../lib/constants";
import { SearchDialog } from "./search-dialog";
import { MobileNav } from "./mobile-nav";

const NAV_ITEMS = [
  { href: "/", label: "Writing" },
  { href: "/cool", label: "Cool" },
  { href: "/adrs", label: "ADRs" },
  { href: "/network", label: "Network" },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="mb-16">
      {/* Logo + search row — generous vertical space */}
      <div className="flex items-center justify-between">
        <Link href="/" className="group flex items-center gap-3">
          <svg
            viewBox="0 0 512 512"
            className="w-9 h-9 shrink-0 text-claw transition-transform duration-300 group-hover:rotate-[-8deg] group-hover:scale-110"
            aria-hidden="true"
          >
            <path fill="currentColor" d={CLAW_PATH} />
          </svg>
          <span className="text-xl font-bold tracking-tight group-hover:text-white transition-colors">
            {SITE_NAME}
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <SearchDialog />
          <MobileNav />
        </div>
      </div>

      {/* Tagline — aligned with text, not icon */}
      <p className="mt-1.5 pl-12 text-[13px] text-neutral-500 tracking-wide">
        {SITE_TAGLINE}
      </p>

      {/* Desktop nav — own row, breathing room, active indicators */}
      <nav className="hidden md:flex items-center gap-1 mt-6 pl-12" role="navigation">
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`relative px-3 py-1.5 text-sm rounded-md transition-all duration-150 ${
                isActive
                  ? "text-white bg-neutral-800/80"
                  : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/40"
              }`}
            >
              {item.label}
              {isActive && (
                <span className="absolute bottom-0 left-3 right-3 h-px bg-claw/60" />
              )}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
