export type Proposal = {
  id: string;
  section: string;
  change: string;
  source?: string;
  timestamp?: string;
};

export type TriageResult = {
  action: "auto-promote" | "auto-reject" | "auto-merge" | "needs-review";
  reason: string;
  mergeWith?: string;
};

const INSTRUCTION_PREFIXES = [
  "add after",
  "add entries",
  "add:",
  "add new",
  "replace ",
  "expand ",
  "consolidate ",
  "strengthen existing",
  "strengthen ",
  "update existing",
  "update the ",
  "remove duplicate",
  "remove all duplicate",
  "confirm and",
  "clarify the",
];

const OPINION_WORDS_RE = /\b(should|wants|prefers|never|always)\b/iu;
const RAW_BULLET_DATE_RE = /^\s*-\s*\(\d{4}-\d{2}-\d{2}\)\s+/u;
const DATE_IN_PARENS_RE = /\(\d{4}-\d{2}-\d{2}\)/u;
const ADR_RE = /\bADR[-\s]?\d{3,4}\b/iu;
const FILE_PATH_RE = /(?:~\/|\/|\.\/|\.\.\/)[\w./-]+|\b[\w.-]+\/[\w./-]+\b/u;
const COMMAND_RE = /`[^`]+`|\b(?:bunx?|pnpm|npm|node|kubectl|redis-cli|git|pi|codex|claude|inngest|typesense|todoist-cli)\b/iu;
const CONFIG_RE = /\.(?:json|ya?ml|toml|ini|env|conf|lock)\b/iu;

function normalizeForSimilarity(input: string): string {
  const collapsed = input
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .replace(/^-\s*\(\d{4}-\d{2}-\d{2}\)\s*/u, "")
    .trim()
    .toLowerCase();
  return collapsed.slice(0, 100);
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const aChar = a[i - 1] ?? "";

    for (let j = 1; j <= b.length; j += 1) {
      const bChar = b[j - 1] ?? "";
      const cost = aChar === bChar ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[j] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[j - 1] ?? Number.POSITIVE_INFINITY) + cost
      );
    }

    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j] ?? Number.POSITIVE_INFINITY;
    }
  }

  return previous[b.length] ?? Math.max(a.length, b.length);
}

function similarityScore(left: string, right: string): number {
  const a = normalizeForSimilarity(left);
  const b = normalizeForSimilarity(right);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLen;
}

function extractMemoryLines(memoryMarkdown: string): string[] {
  return memoryMarkdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

export function isInstructionText(change: string): boolean {
  const trimmed = change.trim().toLowerCase();
  const withoutBulletDate = trimmed.replace(RAW_BULLET_DATE_RE, "").trim();
  return INSTRUCTION_PREFIXES.some((prefix) => withoutBulletDate.startsWith(prefix));
}

function findMostSimilarEntry(text: string, candidates: string[]): { candidate: string; score: number } | null {
  let bestCandidate: string | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = similarityScore(text, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate == null) return null;
  return { candidate: bestCandidate, score: bestScore };
}

function hasSpecificReference(change: string): boolean {
  return ADR_RE.test(change) || FILE_PATH_RE.test(change) || COMMAND_RE.test(change) || CONFIG_RE.test(change);
}

function containsOpinionWords(change: string): boolean {
  return OPINION_WORDS_RE.test(change);
}

function isPromotableSection(section: string): boolean {
  const normalized = section.trim();
  return normalized === "System Architecture" || normalized === "Patterns";
}

export function triageProposal(
  proposal: Proposal,
  existingMemory: string,
  pendingProposals: Proposal[]
): TriageResult {
  const change = proposal.change.trim();

  if (change.length === 0) {
    return { action: "auto-reject", reason: "empty proposal change" };
  }

  if (isInstructionText(change)) {
    return { action: "auto-reject", reason: "instruction text artifact" };
  }

  if (RAW_BULLET_DATE_RE.test(change)) {
    return { action: "auto-reject", reason: "raw leaked bullet format" };
  }

  const memoryLines = extractMemoryLines(existingMemory);
  const memoryMatch = findMostSimilarEntry(change, memoryLines);
  if (memoryMatch && memoryMatch.score >= 0.85) {
    return {
      action: "auto-reject",
      reason: `duplicate of existing MEMORY entry (${Math.round(memoryMatch.score * 100)}% similar)`,
    };
  }

  let bestPending: { proposal: Proposal; score: number } | null = null;
  for (const pending of pendingProposals) {
    if (pending.id === proposal.id) continue;
    const score = similarityScore(change, pending.change);
    if (!bestPending || score > bestPending.score) {
      bestPending = { proposal: pending, score };
    }
  }

  if (bestPending && bestPending.score >= 0.85) {
    const currentLen = change.length;
    const otherLen = bestPending.proposal.change.trim().length;
    if (currentLen > otherLen) {
      return {
        action: "auto-merge",
        reason: `dedup with pending ${bestPending.proposal.id}; keeping longer proposal`,
        mergeWith: bestPending.proposal.id,
      };
    }

    return {
      action: "auto-reject",
      reason: `duplicate of pending ${bestPending.proposal.id}; kept longer proposal`,
    };
  }

  const promotable =
    DATE_IN_PARENS_RE.test(change) &&
    hasSpecificReference(change) &&
    isPromotableSection(proposal.section) &&
    !containsOpinionWords(change);

  if (promotable) {
    return {
      action: "auto-promote",
      reason: "factual timestamped technical update in promotable section",
    };
  }

  return {
    action: "needs-review",
    reason: "ambiguous or preference-driven proposal requires human review",
  };
}
