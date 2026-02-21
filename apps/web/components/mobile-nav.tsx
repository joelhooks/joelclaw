"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { CLAW_PATH } from "../lib/claw";
import { authClient } from "../lib/auth-client";

const PUBLIC_NAV = [
  { href: "/", label: "Writing" },
  { href: "/cool", label: "Cool" },
  { href: "/adrs", label: "ADRs" },
  { href: "/network", label: "Network" },
];

const OWNER_NAV = [
  { href: "/vault", label: "Vault" },
  { href: "/dashboard", label: "System" },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  const navItems = session?.user ? [...PUBLIC_NAV, ...OWNER_NAV] : PUBLIC_NAV;

  // Close on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Escape to close
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && open) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      {/* Hamburger trigger — mobile only */}
      <button
        onClick={() => setOpen(true)}
        className="md:hidden flex items-center text-neutral-500 hover:text-white transition-colors"
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Full-screen overlay */}
      {open && (
        <div className="fixed inset-0 z-50 bg-neutral-950 mobile-nav-overlay md:hidden">
          <div className="flex flex-col h-full px-6 py-8">
            {/* Header row — logo + close */}
            <div className="flex items-center justify-between">
              <Link
                href="/"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3"
              >
                <svg
                  viewBox="0 0 512 512"
                  className="w-8 h-8 text-claw"
                  aria-hidden="true"
                >
                  <path fill="currentColor" d={CLAW_PATH} />
                </svg>
                <span className="text-lg font-semibold text-white">
                  JoelClaw
                </span>
              </Link>
              <button
                onClick={() => setOpen(false)}
                className="p-1 text-neutral-500 hover:text-white transition-colors"
                aria-label="Close menu"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Nav links */}
            <nav className="mt-16 flex flex-col">
              {navItems.map((item, i) => {
                const isActive =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={`mobile-nav-link py-5 text-2xl font-semibold transition-colors border-b border-neutral-800/50 ${
                      isActive
                        ? "text-white"
                        : "text-neutral-400 hover:text-white"
                    }`}
                    style={{
                      animationDelay: `${i * 60}ms`,
                    }}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            {/* Footer */}
            <div className="mt-auto pb-4 text-sm text-neutral-600">
              <span className="font-mono">⌘K</span> to search
            </div>
          </div>
        </div>
      )}
    </>
  );
}
