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
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
          <p className="text-sm text-neutral-400">
            Access the JoelClaw dashboard
          </p>
        </div>
        <button
          onClick={handleGitHubSignIn}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-neutral-800 px-4 py-3 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-neutral-600"
        >
          <Github className="h-5 w-5" />
          Continue with GitHub
        </button>
      </div>
    </div>
  );
}
