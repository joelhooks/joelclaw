export const TAXONOMY_VERSION = "v1";

export type MemoryCategoryId =
  | "jc:preferences"
  | "jc:rules-conventions"
  | "jc:system-architecture"
  | "jc:operations"
  | "jc:memory-system"
  | "jc:projects"
  | "jc:people-relationships";

export type CategorySource = "rules" | "llm" | "fallback" | "external";

export interface CategoryClassification {
  categoryId: MemoryCategoryId;
  categoryConfidence: number;
  categorySource: CategorySource;
  taxonomyVersion: string;
}

type CategoryDefinition = {
  id: MemoryCategoryId;
  keywords: string[];
};

const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  {
    id: "jc:preferences",
    keywords: ["prefers", "preference", "likes", "wants", "tone", "voice"],
  },
  {
    id: "jc:rules-conventions",
    keywords: ["rule", "convention", "must", "never", "always", "hard rule", "policy"],
  },
  {
    id: "jc:system-architecture",
    keywords: ["architecture", "design", "adr", "pattern", "topology", "system"],
  },
  {
    id: "jc:operations",
    keywords: ["deploy", "restart", "status", "incident", "error", "triage", "worker", "gateway"],
  },
  {
    id: "jc:memory-system",
    keywords: ["memory", "observe", "reflect", "proposal", "recall", "typesense", "echo", "fizzle"],
  },
  {
    id: "jc:projects",
    keywords: ["project", "roadmap", "milestone", "epic", "feature", "ship"],
  },
  {
    id: "jc:people-relationships",
    keywords: ["joel", "miller", "person", "relationship", "meeting", "email", "contact"],
  },
];

const CATEGORY_ALIAS_MAP = new Map<string, MemoryCategoryId>([
  ["preferences", "jc:preferences"],
  ["jc:preferences", "jc:preferences"],
  ["rules", "jc:rules-conventions"],
  ["conventions", "jc:rules-conventions"],
  ["hard-rules", "jc:rules-conventions"],
  ["jc:rules-conventions", "jc:rules-conventions"],
  ["system-architecture", "jc:system-architecture"],
  ["architecture", "jc:system-architecture"],
  ["jc:system-architecture", "jc:system-architecture"],
  ["operations", "jc:operations"],
  ["ops", "jc:operations"],
  ["o11y-triage", "jc:operations"],
  ["jc:operations", "jc:operations"],
  ["memory", "jc:memory-system"],
  ["memory-system", "jc:memory-system"],
  ["jc:memory-system", "jc:memory-system"],
  ["project", "jc:projects"],
  ["projects", "jc:projects"],
  ["jc:projects", "jc:projects"],
  ["people", "jc:people-relationships"],
  ["relationships", "jc:people-relationships"],
  ["jc:people-relationships", "jc:people-relationships"],
]);

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

export function normalizeCategoryId(input: string | undefined | null): MemoryCategoryId | null {
  if (!input) return null;
  const normalized = normalizeText(input).replace(/[^a-z0-9:-]/gu, "-");
  return CATEGORY_ALIAS_MAP.get(normalized) ?? null;
}

export function classifyObservationCategory(text: string): CategoryClassification {
  const normalized = normalizeText(text);
  if (normalized.length === 0) {
    return {
      categoryId: "jc:operations",
      categoryConfidence: 0.35,
      categorySource: "fallback",
      taxonomyVersion: TAXONOMY_VERSION,
    };
  }

  let best: { id: MemoryCategoryId; score: number } | null = null;

  for (const category of CATEGORY_DEFINITIONS) {
    let score = 0;
    for (const keyword of category.keywords) {
      if (normalized.includes(keyword)) {
        score += 1;
      }
    }

    if (!best || score > best.score) {
      best = { id: category.id, score };
    }
  }

  if (!best || best.score <= 0) {
    return {
      categoryId: "jc:operations",
      categoryConfidence: 0.35,
      categorySource: "fallback",
      taxonomyVersion: TAXONOMY_VERSION,
    };
  }

  return {
    categoryId: best.id,
    categoryConfidence: clamp(0.55 + best.score * 0.12, 0.55, 0.95),
    categorySource: "rules",
    taxonomyVersion: TAXONOMY_VERSION,
  };
}
