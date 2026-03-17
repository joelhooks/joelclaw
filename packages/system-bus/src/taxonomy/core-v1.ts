export const TAXONOMY_VERSION = "v1";

export type ConceptState = "canonical" | "candidate" | "deprecated";

export type ConceptId =
  | "jc:docs:general"
  | "jc:docs:programming"
  | "jc:docs:programming:systems"
  | "jc:docs:programming:languages"
  | "jc:docs:programming:architecture"
  | "jc:docs:business"
  | "jc:docs:business:creator"
  | "jc:docs:education"
  | "jc:docs:education:learning-science"
  | "jc:docs:education:pedagogy"
  | "jc:docs:design"
  | "jc:docs:design:game"
  | "jc:docs:design:systems"
  | "jc:docs:design:product"
  | "jc:docs:marketing"
  | "jc:docs:strategy"
  | "jc:docs:ai"
  | "jc:docs:ai:agents"
  | "jc:docs:ai:applied"
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
    narrower: [
      "jc:docs:programming:systems",
      "jc:docs:programming:languages",
      "jc:docs:programming:architecture",
    ],
    related: ["jc:docs:ai"],
    scopeNote: "Software engineering, code, architecture, and technical implementation.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:programming:systems",
    prefLabel: "Systems",
    altLabels: ["distributed-systems", "databases", "networking"],
    broader: ["jc:docs:programming"],
    narrower: [],
    related: ["jc:docs:ai:applied"],
    scopeNote: "Distributed systems, databases, networking, infrastructure internals.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:programming:languages",
    prefLabel: "Languages",
    altLabels: ["rust", "typescript", "language-design", "compilers"],
    broader: ["jc:docs:programming"],
    narrower: [],
    related: [],
    scopeNote: "Programming languages, type systems, compilers, language design.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:programming:architecture",
    prefLabel: "Architecture",
    altLabels: ["patterns", "ddd", "clean-architecture", "hexagonal"],
    broader: ["jc:docs:programming"],
    narrower: [],
    related: ["jc:docs:design:systems"],
    scopeNote: "Software architecture patterns, DDD, clean arch, microservices.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:business",
    prefLabel: "Business",
    altLabels: ["company", "finance", "entrepreneurship", "sales"],
    broader: [],
    narrower: ["jc:docs:business:creator"],
    related: ["jc:docs:marketing", "jc:docs:strategy"],
    scopeNote: "Business operations, management, finance, and growth.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:business:creator",
    prefLabel: "Creator Economy",
    altLabels: ["creator-economy", "indie-business", "audience-building", "bootstrapped"],
    broader: ["jc:docs:business"],
    narrower: [],
    related: ["jc:docs:marketing"],
    scopeNote: "Creator economy, indie business, audience building, solopreneurship.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:education",
    prefLabel: "Education",
    altLabels: ["learning", "teaching", "curriculum", "training"],
    broader: [],
    narrower: ["jc:docs:education:learning-science", "jc:docs:education:pedagogy"],
    related: [],
    scopeNote: "Learning resources, instructional material, and pedagogy.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:education:learning-science",
    prefLabel: "Learning Science",
    altLabels: ["cognitive-science", "learning-theory", "memory", "cognitive-load"],
    broader: ["jc:docs:education"],
    narrower: [],
    related: ["jc:docs:ai"],
    scopeNote: "Cognitive science, memory, transfer, cognitive load theory.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:education:pedagogy",
    prefLabel: "Pedagogy",
    altLabels: ["instructional-design", "ubd", "curriculum-design"],
    broader: ["jc:docs:education"],
    narrower: [],
    related: [],
    scopeNote: "Instructional design, Understanding by Design, curriculum.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:design",
    prefLabel: "Design",
    altLabels: ["ux", "ui", "product design", "visual design"],
    broader: [],
    narrower: [
      "jc:docs:design:game",
      "jc:docs:design:systems",
      "jc:docs:design:product",
    ],
    related: ["jc:docs:marketing"],
    scopeNote: "Interface, product, systems, and visual design practices.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:design:game",
    prefLabel: "Game Design",
    altLabels: ["game-design", "game-feel", "play", "interactivity"],
    broader: ["jc:docs:design"],
    narrower: [],
    related: ["jc:docs:education"],
    scopeNote: "Game design, play, mechanics, interactivity, ludology.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:design:systems",
    prefLabel: "Systems Design",
    altLabels: ["systems-thinking", "complexity", "emergence"],
    broader: ["jc:docs:design"],
    narrower: [],
    related: ["jc:docs:programming:architecture"],
    scopeNote: "Systems thinking, complexity theory, emergence, feedback loops.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:design:product",
    prefLabel: "Product Design",
    altLabels: ["product-design", "ux", "interaction-design"],
    broader: ["jc:docs:design"],
    narrower: [],
    related: ["jc:docs:marketing"],
    scopeNote: "Product and UX design, interaction patterns, usability.",
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
    narrower: ["jc:docs:ai:agents", "jc:docs:ai:applied"],
    related: ["jc:docs:programming"],
    scopeNote: "Artificial intelligence, models, tooling, and agent systems.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:ai:agents",
    prefLabel: "AI Agents",
    altLabels: ["autonomous-agents", "tool-use", "agent-planning", "multi-agent"],
    broader: ["jc:docs:ai"],
    narrower: [],
    related: ["jc:docs:programming:systems"],
    scopeNote: "Autonomous agents, tool use, planning, multi-agent orchestration.",
    taxonomy_version: TAXONOMY_VERSION,
    state: "canonical",
  },
  {
    id: "jc:docs:ai:applied",
    prefLabel: "Applied AI",
    altLabels: ["rag", "embeddings", "vector-search", "production-ai"],
    broader: ["jc:docs:ai"],
    narrower: [],
    related: ["jc:docs:programming:systems"],
    scopeNote: "RAG, embeddings, vector search, production AI systems.",
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
  "jc:docs:programming:systems": "programming",
  "jc:docs:programming:languages": "programming",
  "jc:docs:programming:architecture": "programming",
  "jc:docs:business": "business",
  "jc:docs:business:creator": "business",
  "jc:docs:education": "education",
  "jc:docs:education:learning-science": "education",
  "jc:docs:education:pedagogy": "education",
  "jc:docs:design": "design",
  "jc:docs:design:game": "design",
  "jc:docs:design:systems": "design",
  "jc:docs:design:product": "design",
  "jc:docs:marketing": "business",
  "jc:docs:strategy": "business",
  "jc:docs:ai": "programming",
  "jc:docs:ai:agents": "programming",
  "jc:docs:ai:applied": "programming",
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
