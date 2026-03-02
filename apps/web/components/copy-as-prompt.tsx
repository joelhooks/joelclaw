"use client";

import { Check } from "lucide-react";
import { useCallback, useState } from "react";
import { CLAW_PATH } from "@/lib/claw";
import { buildCopyPrompt } from "@/lib/copy-prompt";

interface CopyAsPromptProps {
  title: string;
  slug: string;
  description?: string;
}

function ClawIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className}>
      <path fill="currentColor" d={CLAW_PATH} />
    </svg>
  );
}

export function CopyAsPrompt({ title, slug, description }: CopyAsPromptProps) {
  const [copied, setCopied] = useState(false);
  const [grabbing, setGrabbing] = useState(false);

  const handleCopy = useCallback(async () => {
    setGrabbing(true);
    const prompt = buildCopyPrompt({ title, slug, description });
    await navigator.clipboard.writeText(prompt);

    // Grab animation, then show "copied"
    setTimeout(() => {
      setGrabbing(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }, 400);
  }, [title, slug, description]);

  return (
    <button
      onClick={handleCopy}
      className="group inline-flex items-center gap-1.5 text-xs font-mono text-neutral-500 hover:text-claw transition-colors border border-neutral-800 hover:border-claw/50 rounded px-2.5 py-1.5"
      title="Copy as agent prompt"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-green-500" />
          <span className="text-green-500">snatched</span>
        </>
      ) : (
        <>
          <ClawIcon
            className={`h-3.5 w-3.5 transition-transform duration-300 ease-out ${
              grabbing
                ? "scale-125 rotate-[-15deg]"
                : "group-hover:rotate-[-8deg] group-hover:scale-110"
            }`}
          />
          <span>copy for your claw</span>
        </>
      )}
    </button>
  );
}
