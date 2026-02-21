"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CLAW_PATH } from "../lib/claw";
import { SITE_NAME } from "../lib/constants";
import { SearchDialog } from "./search-dialog";
import { MobileNav } from "./mobile-nav";

const NAV_ITEMS = [
  { href: "/", label: "Writing" },
  { href: "/cool", label: "Cool" },
  { href: "/adrs", label: "ADRs" },
  { href: "/network", label: "Network" },
  { href: "/dashboard", label: "System" },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="mb-16">
      <div className="flex items-center justify-between">
        <Link href="/" className="group flex items-center gap-3">
          <svg
            viewBox="0 0 512 512"
            className="w-8 h-8 shrink-0 text-claw transition-transform group-hover:rotate-[-8deg]"
            aria-hidden="true"
          >
            <path fill="currentColor" d={CLAW_PATH} />
          </svg>
          <span className="text-lg font-semibold group-hover:text-white transition-colors">
            {SITE_NAME}
          </span>
        </Link>
        <div className="flex items-center gap-6">
          <nav className="hidden md:flex items-center gap-6 text-sm">
            {NAV_ITEMS.map((item) => {
              const isActive =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`transition-colors ${
                    isActive
                      ? "text-white"
                      : "text-neutral-500 hover:text-white"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <SearchDialog />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
