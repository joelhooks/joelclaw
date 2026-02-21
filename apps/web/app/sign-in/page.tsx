"use client";

import { authClient } from "@/lib/auth-client";
import { Github } from "lucide-react";

export default function SignInPage() {
  const handleGitHubSignIn = () => {
    authClient.signIn.social({
      provider: "github",
      callbackURL: "/dashboard",
    });
  };

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center">
      <div className="relative w-full max-w-xs">
        {/* Decorative glow */}
        <div className="absolute -inset-px rounded-xl bg-gradient-to-b from-claw/20 via-transparent to-transparent blur-xl" />

        <div className="relative space-y-8 rounded-xl border border-neutral-800/60 bg-neutral-950/80 p-8 shadow-2xl shadow-claw/5 backdrop-blur-sm">
          {/* Header */}
          <div className="space-y-1">
            <p className="font-pixel text-[11px] uppercase tracking-[0.15em] text-neutral-600">
              authenticate
            </p>
            <h1 className="font-mono text-lg text-neutral-200">
              joelclaw<span className="text-claw">.</span>system
            </h1>
          </div>

          {/* Divider with pulse */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-neutral-800" />
            <div className="h-1.5 w-1.5 rounded-full bg-claw animate-pulse" />
            <div className="h-px flex-1 bg-neutral-800" />
          </div>

          {/* Sign in button */}
          <button
            onClick={handleGitHubSignIn}
            className="group flex w-full items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/50 px-4 py-3.5 font-mono text-sm text-neutral-300 transition-all duration-200 hover:border-neutral-700 hover:bg-neutral-900 hover:text-white hover:shadow-lg hover:shadow-claw/5"
          >
            <Github className="h-4 w-4 text-neutral-500 transition-colors group-hover:text-claw" />
            <span className="flex-1 text-left">Continue with GitHub</span>
            <span className="text-[10px] text-neutral-600 transition-colors group-hover:text-neutral-400">
              →
            </span>
          </button>

          {/* Footer */}
          <p className="text-center font-pixel text-[10px] text-neutral-700">
            restricted access
          </p>
        </div>
      </div>
    </div>
  );
}
