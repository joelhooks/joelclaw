"use client";

import { Check, Copy, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";

interface CopyAsPromptProps {
  markdown: string;
  title: string;
  slug: string;
}

function buildPrompt(markdown: string, title: string, slug: string): string {
  return `# Spec: ${title}

Source: https://joelclaw.com/${slug}

## Instructions

Build a system matching this spec. Use whatever tools and frameworks match your current project. The architecture matters more than the specific implementations mentioned.

Before starting:
- Read the full spec
- Ask clarifying questions about anything ambiguous
- Propose your tech choices for each component before writing code
- Build incrementally — get the core loop working before adding polish

## Spec

${markdown}
`;
}

export function CopyAsPrompt({ markdown, title, slug }: CopyAsPromptProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const prompt = buildPrompt(markdown, title, slug);
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [markdown, title, slug]);

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 text-xs font-mono text-neutral-500 hover:text-claw transition-colors border border-neutral-800 hover:border-claw/50 rounded px-2 py-1"
      title="Copy as agent prompt"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" />
          copied
        </>
      ) : (
        <>
          <Sparkles className="h-3 w-3" />
          copy as prompt
        </>
      )}
    </button>
  );
}
