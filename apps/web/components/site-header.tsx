"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useEffect, useState, useCallback } from "react";
import { CLAW_PATH } from "@/lib/claw";
import { SITE_NAME } from "@/lib/constants";
import { SearchDialog } from "./search-dialog";
import { MobileNav } from "./mobile-nav";
import { authClient } from "@/lib/auth-client";

const PUBLIC_NAV = [
  { href: "/", label: "Writing" },
  { href: "/cool", label: "Cool" },
  { href: "/adrs", label: "ADRs" },
  { href: "/network", label: "Network" },
];

const OWNER_NAV = [
  { href: "/vault", label: "Vault" },
  { href: "/memory", label: "Memory" },
  { href: "/syslog", label: "Syslog" },
  { href: "/system", label: "Ops" },
  { href: "/dashboard", label: "System" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  const isOwner = !!session?.user;

  const navItems = isOwner ? [...PUBLIC_NAV, ...OWNER_NAV] : PUBLIC_NAV;

  const navRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{
    left: number;
    width: number;
  } | null>(null);

  const updateIndicator = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const activeLink = nav.querySelector("[data-active]") as HTMLElement | null;
    if (!activeLink) {
      setIndicator(null);
      return;
    }
    const navRect = nav.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();
    setIndicator({
      left: linkRect.left - navRect.left,
      width: linkRect.width,
    });
  }, []);

  // Update on pathname or nav items change
  useEffect(() => {
    updateIndicator();
  }, [pathname, isOwner, updateIndicator]);

  // Recalculate on resize
  useEffect(() => {
    window.addEventListener("resize", updateIndicator);
    return () => window.removeEventListener("resize", updateIndicator);
  }, [updateIndicator]);

  return (
    <header className="mb-16">
      <div className="flex items-center justify-between">
        <Link href="/" className="group flex items-center gap-3">
          <svg
            viewBox="0 0 512 512"
            className="w-8 h-8 shrink-0 text-claw transition-transform duration-200 ease-out group-hover:rotate-[-8deg] motion-reduce:transition-none"
            aria-hidden="true"
          >
            <path fill="currentColor" d={CLAW_PATH} />
          </svg>
          <span className="text-lg font-semibold group-hover:text-white transition-colors duration-200 ease-out">
            {SITE_NAME}
          </span>
        </Link>
        <div className="flex items-center gap-6">
          <nav
            ref={navRef}
            className="hidden md:flex items-center gap-6 lg:gap-8 text-sm relative"
          >
            {/* Sliding indicator */}
            {indicator && (
              <span
                className="absolute -bottom-1.5 h-px bg-claw/60 transition-[left,width] duration-200 motion-reduce:transition-none"
                style={{
                  left: indicator.left,
                  width: indicator.width,
                  // Slightly sharper than default ease-out
                  transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
                }}
              />
            )}

            {navItems.map((item) => {
              const isActive =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  {...(isActive ? { "data-active": true } : {})}
                  className={`transition-colors duration-200 ease-out ${
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
