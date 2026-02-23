export const TAXONOMY_VERSION = "v1";

export type ConceptState = "canonical" | "candidate" | "deprecated";

export type ConceptId =
  | "jc:docs:general"
  | "jc:docs:programming"
  | "jc:docs:business"
  | "jc:docs:education"
  | "jc:docs:design"
  | "jc:docs:marketing"
  | "jc:docs:strategy"
  | "jc:docs:ai"
  | "jc:docs:operations"
  | "jc:docs:podcast";

export type StorageCategory =
  | "programming"
  | "business"
  | "education"
  | "design"
  | "other"
  | "uncategorized"
  | "podcasts";

export interface TaxonomyConcept {
  id: ConceptId;
  prefLabel: string;
  altLabels: string[];
  broader: ConceptId[];
  narrower: ConceptId[];
  related: ConceptId[];
  scopeNote: string;
  taxonomy_version: string;
  state: ConceptState;
}

export const TAXONOMY_CORE_V1: TaxonomyConcept[] = [
  {
    id: "jc:docs:general",
    prefLabel: "General",
    altLabels: ["misc", "uncategorized", "other"],
    broader: [],
    narrower: [],
    related: [],
    scopeNote: "Fallback concept for documents that do not map to a specific domain.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:programming",
    prefLabel: "Programming",
    altLabels: ["software", "coding", "development", "computer science"],
    broader: [],
    narrower: [],
    related: ["jc:docs:ai"],
    scopeNote: "Software engineering, code, architecture, and technical implementation.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:business",
    prefLabel: "Business",
    altLabels: ["company", "finance", "entrepreneurship", "sales"],
    broader: [],
    narrower: [],
    related: ["jc:docs:marketing", "jc:docs:strategy"],
    scopeNote: "Business operations, management, finance, and growth.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:education",
    prefLabel: "Education",
    altLabels: ["learning", "teaching", "curriculum", "training"],
    broader: [],
    narrower: [],
    related: [],
    scopeNote: "Learning resources, instructional material, and pedagogy.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:design",
    prefLabel: "Design",
    altLabels: ["ux", "ui", "product design", "visual design"],
    broader: [],
    narrower: [],
    related: ["jc:docs:marketing"],
    scopeNote: "Interface, product, systems, and visual design practices.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:marketing",
    prefLabel: "Marketing",
    altLabels: ["growth", "positioning", "brand", "copywriting"],
    broader: [],
    narrower: [],
    related: ["jc:docs:business", "jc:docs:strategy"],
    scopeNote: "Audience growth, messaging, distribution, and brand development.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:strategy",
    prefLabel: "Strategy",
    altLabels: ["planning", "roadmap", "go-to-market", "execution strategy"],
    broader: [],
    narrower: [],
    related: ["jc:docs:business", "jc:docs:operations"],
    scopeNote: "Strategic planning, prioritization, and execution frameworks.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:ai",
    prefLabel: "AI",
    altLabels: ["machine learning", "llm", "agents", "artificial intelligence"],
    broader: [],
    narrower: [],
    related: ["jc:docs:programming"],
    scopeNote: "Artificial intelligence, models, tooling, and agent systems.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:operations",
    prefLabel: "Operations",
    altLabels: ["ops", "runbook", "incident", "platform"],
    broader: [],
    narrower: [],
    related: ["jc:docs:strategy", "jc:docs:business"],
    scopeNote: "Operational reliability, deployment, infrastructure, and runbooks.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:podcast",
    prefLabel: "Podcast",
    altLabels: ["audio", "episode", "show"],
    broader: [],
    narrower: [],
    related: ["jc:docs:education"],
    scopeNote: "Podcast episode notes, transcripts, and audio-adjacent content.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
];

const STORAGE_CATEGORY_DEFAULTS: Record<ConceptId, StorageCategory> = {
  "jc:docs:general": "uncategorized",
  "jc:docs:programming": "programming",
  "jc:docs:business": "business",
  "jc:docs:education": "education",
  "jc:docs:design": "design",
  "jc:docs:marketing": "business",
  "jc:docs:strategy": "business",
  "jc:docs:ai": "programming",
  "jc:docs:operations": "other",
  "jc:docs:podcast": "podcasts",
};

const CONCEPT_INDEX = new Map<ConceptId, TaxonomyConcept>(
  TAXONOMY_CORE_V1.map((concept) => [concept.id, concept])
);

export function getConceptById(conceptId: string | null | undefined): TaxonomyConcept | null {
  if (!conceptId) return null;
  return CONCEPT_INDEX.get(conceptId as ConceptId) ?? null;
}

export function isStorageCategory(value: string | null | undefined): value is StorageCategory {
  return (
    value === "programming" ||
    value === "business" ||
    value === "education" ||
    value === "design" ||
    value === "other" ||
    value === "uncategorized" ||
    value === "podcasts"
  );
}

export function getStorageCategoryForConcept(
  conceptId: ConceptId | null | undefined
): StorageCategory {
  if (!conceptId) return "uncategorized";
  return STORAGE_CATEGORY_DEFAULTS[conceptId] ?? "uncategorized";
}
