export interface CopyPromptInput {
  title: string;
  slug: string;
  description?: string;
}

function canonicalMarkdownUrl(slug: string): string {
  const normalizedSlug = slug
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.md$/i, "")
    .replace(/\/md$/i, "");

  return `https://joelclaw.com/${normalizedSlug}.md`;
}

export function buildCopyPrompt({ title, slug, description }: CopyPromptInput): string {
  const normalizedDescription = description?.trim();
  const summaryLine = normalizedDescription ? `\nSummary: ${normalizedDescription}\n` : "\n";

  return `Explain this to your operator: ${canonicalMarkdownUrl(slug)}

Title: ${title}${summaryLine}
Start with a concise explanation of intent, architecture, and tradeoffs.
Ask clarifying questions before proposing implementation steps.
`;
}
