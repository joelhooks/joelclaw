"use client";

import { useEffect, useState, useRef, useCallback } from "react";
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
  { href: "/memory", label: "Memory" },
  { href: "/syslog", label: "Syslog" },
  { href: "/system", label: "Ops" },
  { href: "/dashboard", label: "System" },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  const navItems = session?.user ? [...PUBLIC_NAV, ...OWNER_NAV] : PUBLIC_NAV;
  const overlayRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setClosing(true);
    // Match the exit animation duration
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 150);
  }, []);

  // Close on route change
  useEffect(() => {
    if (open) close();
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (e.key === "Escape" && open) close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="md:hidden flex items-center text-neutral-500 hover:text-white transition-colors duration-200 ease-out"
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      {open && (
        <div
          ref={overlayRef}
          className={`fixed inset-0 z-50 bg-neutral-950 md:hidden ${
            closing ? "mobile-nav-overlay-exit" : "mobile-nav-overlay"
          }`}
        >
          <div className="flex flex-col h-full px-6 py-8">
            <div className="flex items-center justify-between">
              <Link
                href="/"
                onClick={close}
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
                onClick={close}
                className="p-1 text-neutral-500 hover:text-white transition-colors duration-200 ease-out"
                aria-label="Close menu"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

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
                    onClick={close}
                    className={`py-5 text-2xl font-semibold transition-colors duration-200 ease-out border-b border-neutral-800/50 ${
                      closing ? "mobile-nav-link-exit" : "mobile-nav-link"
                    } ${
                      isActive
                        ? "text-white"
                        : "text-neutral-400 hover:text-white"
                    }`}
                    style={{
                      animationDelay: closing
                        ? `${(navItems.length - 1 - i) * 30}ms`
                        : `${i * 60}ms`,
                    }}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="mt-auto pb-4 text-sm text-neutral-600">
              <span className="font-mono">⌘K</span> to search
            </div>
          </div>
        </div>
      )}
    </>
  );
}
