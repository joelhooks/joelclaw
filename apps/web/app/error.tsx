"use client";

import { useEffect } from "react";

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md items-center justify-center">
      <div className="relative w-full max-w-xs">
        <div className="absolute -inset-px rounded-xl bg-gradient-to-b from-claw/20 via-transparent to-transparent blur-xl" />

        <div className="relative space-y-6 rounded-xl border border-neutral-800/60 bg-neutral-950/80 p-8 shadow-2xl shadow-claw/5 backdrop-blur-sm">
          <div className="space-y-1">
            <p className="font-pixel text-[11px] uppercase tracking-[0.15em] text-neutral-600">
              route error
            </p>
            <h1 className="font-mono text-lg text-neutral-200">
              joelclaw<span className="text-claw">.</span>system
            </h1>
          </div>

          <div className="space-y-2 rounded-lg border border-neutral-800/70 bg-neutral-900/40 p-3">
            <p className="font-mono text-xs text-neutral-300">
              {error.message || "something went wrong"}
            </p>
            <p className="font-mono text-[10px] text-neutral-500">
              digest: {error.digest ?? "none"}
            </p>
          </div>

          <button
            onClick={() => reset()}
            className="group flex w-full items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/50 px-4 py-3 font-mono text-sm text-neutral-300 transition-[color,background-color,border-color,box-shadow] duration-200 ease-out hover:border-neutral-700 hover:bg-neutral-900 hover:text-white hover:shadow-lg hover:shadow-claw/5"
          >
            <span className="flex-1 text-left">Try again</span>
            <span className="text-[10px] text-neutral-600 transition-colors group-hover:text-neutral-400">
              ↺
            </span>
          </button>

          <p className="text-center font-pixel text-[10px] text-neutral-700">
            recover and continue
          </p>
        </div>
      </div>
    </div>
  );
}
