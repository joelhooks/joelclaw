import { TAXONOMY_ALIASES_V1 } from "./aliases-v1";
import {
  type ConceptId,
  getStorageCategoryForConcept,
  isStorageCategory,
  type StorageCategory,
  TAXONOMY_CORE_V1,
  TAXONOMY_VERSION,
} from "./core-v1";

export type ConceptSource = "rules" | "llm" | "backfill" | "manual" | "fallback";

export interface ResolveConceptsInput {
  labels?: string[];
  fallbackConceptId?: ConceptId;
}

export interface ResolveConceptsResult {
  primaryConceptId: ConceptId;
  conceptIds: ConceptId[];
  conceptSource: ConceptSource;
  taxonomyVersion: string;
  diagnostics: {
    aliasHits: number;
    mappedCount: number;
    unmappedCount: number;
    unmappedLabels: string[];
  };
}

const DEFAULT_FALLBACK_CONCEPT: ConceptId = "jc:docs:general";

function normalizeAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokenize(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  const normalized = normalizeAlias(value);
  const parts = normalized.split("-").filter(Boolean);
  const tokens = new Set<string>([normalized, ...parts]);
  return [...tokens];
}

function buildAliasMap(): Map<string, ConceptId> {
  const map = new Map<string, ConceptId>();

  for (const concept of TAXONOMY_CORE_V1) {
    const pref = normalizeAlias(concept.prefLabel);
    if (pref) map.set(pref, concept.id);
    map.set(normalizeAlias(concept.id), concept.id);
    for (const label of concept.altLabels) {
      const alias = normalizeAlias(label);
      if (alias && !map.has(alias)) {
        map.set(alias, concept.id);
      }
    }
  }

  for (const aliasEntry of TAXONOMY_ALIASES_V1) {
    const alias = normalizeAlias(aliasEntry.alias);
    if (alias && !map.has(alias)) {
      map.set(alias, aliasEntry.conceptId);
    }
  }

  return map;
}

const ALIAS_MAP = buildAliasMap();

export function resolveConceptId(label: string | null | undefined): ConceptId | null {
  if (!label) return null;
  const direct = ALIAS_MAP.get(normalizeAlias(label));
  if (direct) return direct;

  for (const token of tokenize(label)) {
    const resolved = ALIAS_MAP.get(token);
    if (resolved) return resolved;
  }

  return null;
}

export function resolveConcepts(input: ResolveConceptsInput = {}): ResolveConceptsResult {
  const labels = input.labels ?? [];
  const fallbackConceptId = input.fallbackConceptId ?? DEFAULT_FALLBACK_CONCEPT;
  const scores = new Map<ConceptId, number>();
  const conceptOrder: ConceptId[] = [];
  let aliasHits = 0;
  let mappedCount = 0;
  const unmappedLabels: string[] = [];

  for (const rawLabel of labels) {
    const label = rawLabel.trim();
    if (!label) continue;

    const matched = resolveConceptId(label);
    if (!matched) {
      unmappedLabels.push(label);
      continue;
    }

    mappedCount += 1;
    aliasHits += 1;
    if (!scores.has(matched)) {
      conceptOrder.push(matched);
      scores.set(matched, 0);
    }
    scores.set(matched, (scores.get(matched) ?? 0) + 1);
  }

  const conceptIds = conceptOrder
    .sort((left, right) => (scores.get(right) ?? 0) - (scores.get(left) ?? 0));

  const resolvedConceptIds = conceptIds.length > 0 ? conceptIds : [fallbackConceptId];
  const primaryConceptId = resolvedConceptIds[0] ?? fallbackConceptId;

  return {
    primaryConceptId,
    conceptIds: resolvedConceptIds,
    conceptSource: conceptIds.length > 0 ? "rules" : "fallback",
    taxonomyVersion: TAXONOMY_VERSION,
    diagnostics: {
      aliasHits,
      mappedCount,
      unmappedCount: unmappedLabels.length,
      unmappedLabels,
    },
  };
}

function normalizeNasPathCategory(nasPath: string): StorageCategory | null {
  const lower = nasPath.toLowerCase();
  if (lower.includes("/podcasts/")) return "podcasts";

  const match = lower.match(/\/books\/([^/]+)\//);
  const category = match?.[1];
  if (!category) return null;
  if (isStorageCategory(category)) return category;
  return null;
}

export function resolveStorageCategory(input: {
  explicitCategory?: string | null;
  nasPath?: string | null;
  primaryConceptId?: ConceptId | null;
}): StorageCategory {
  if (isStorageCategory(input.explicitCategory)) {
    return input.explicitCategory;
  }

  if (input.nasPath) {
    const fromPath = normalizeNasPathCategory(input.nasPath);
    if (fromPath) return fromPath;
  }

  return getStorageCategoryForConcept(input.primaryConceptId ?? null);
}
