import type { ConceptId } from "./core-v1";

export interface TaxonomyAliasRecord {
  alias: string;
  conceptId: ConceptId;
}

export const TAXONOMY_ALIASES_V1: TaxonomyAliasRecord[] = [
  { alias: "general", conceptId: "jc:docs:general" },
  { alias: "misc", conceptId: "jc:docs:general" },
  { alias: "uncategorized", conceptId: "jc:docs:general" },
  { alias: "other", conceptId: "jc:docs:general" },

  { alias: "programming", conceptId: "jc:docs:programming" },
  { alias: "software", conceptId: "jc:docs:programming" },
  { alias: "coding", conceptId: "jc:docs:programming" },
  { alias: "development", conceptId: "jc:docs:programming" },
  { alias: "engineering", conceptId: "jc:docs:programming" },
  { alias: "computer-science", conceptId: "jc:docs:programming" },

  { alias: "business", conceptId: "jc:docs:business" },
  { alias: "finance", conceptId: "jc:docs:business" },
  { alias: "sales", conceptId: "jc:docs:business" },
  { alias: "entrepreneurship", conceptId: "jc:docs:business" },

  { alias: "education", conceptId: "jc:docs:education" },
  { alias: "learning", conceptId: "jc:docs:education" },
  { alias: "teaching", conceptId: "jc:docs:education" },
  { alias: "curriculum", conceptId: "jc:docs:education" },
  { alias: "training", conceptId: "jc:docs:education" },

  { alias: "design", conceptId: "jc:docs:design" },
  { alias: "ux", conceptId: "jc:docs:design" },
  { alias: "ui", conceptId: "jc:docs:design" },
  { alias: "product-design", conceptId: "jc:docs:design" },
  { alias: "visual-design", conceptId: "jc:docs:design" },

  { alias: "marketing", conceptId: "jc:docs:marketing" },
  { alias: "growth", conceptId: "jc:docs:marketing" },
  { alias: "brand", conceptId: "jc:docs:marketing" },
  { alias: "copywriting", conceptId: "jc:docs:marketing" },
  { alias: "positioning", conceptId: "jc:docs:marketing" },

  { alias: "strategy", conceptId: "jc:docs:strategy" },
  { alias: "planning", conceptId: "jc:docs:strategy" },
  { alias: "roadmap", conceptId: "jc:docs:strategy" },
  { alias: "go-to-market", conceptId: "jc:docs:strategy" },

  { alias: "ai", conceptId: "jc:docs:ai" },
  { alias: "machine-learning", conceptId: "jc:docs:ai" },
  { alias: "llm", conceptId: "jc:docs:ai" },
  { alias: "agents", conceptId: "jc:docs:ai" },
  { alias: "artificial-intelligence", conceptId: "jc:docs:ai" },

  { alias: "operations", conceptId: "jc:docs:operations" },
  { alias: "ops", conceptId: "jc:docs:operations" },
  { alias: "runbook", conceptId: "jc:docs:operations" },
  { alias: "incident", conceptId: "jc:docs:operations" },
  { alias: "platform", conceptId: "jc:docs:operations" },

  { alias: "podcast", conceptId: "jc:docs:podcast" },
  { alias: "audio", conceptId: "jc:docs:podcast" },
  { alias: "episode", conceptId: "jc:docs:podcast" },
  { alias: "show", conceptId: "jc:docs:podcast" },
];
