import { expect, test } from "bun:test";
import { getConceptById, getStorageCategoryForConcept } from "./core-v1";
import { resolveConceptId, resolveConcepts } from "./resolve";

test("deep taxonomy concepts expose hierarchy and storage defaults", () => {
  expect(getConceptById("jc:docs:programming")?.narrower).toEqual([
    "jc:docs:programming:systems",
    "jc:docs:programming:languages",
    "jc:docs:programming:architecture",
  ]);
  expect(getConceptById("jc:docs:design:systems")?.broader).toEqual(["jc:docs:design"]);
  expect(getStorageCategoryForConcept("jc:docs:ai:agents")).toBe("programming");
  expect(getStorageCategoryForConcept("jc:docs:business:creator")).toBe("business");
});

test("resolveConceptId maps new sub-concepts from aliases and pref labels", () => {
  expect(resolveConceptId("distributed systems")).toBe("jc:docs:programming:systems");
  expect(resolveConceptId("rust")).toBe("jc:docs:programming:languages");
  expect(resolveConceptId("systems design")).toBe("jc:docs:design:systems");
  expect(resolveConceptId("creator economy")).toBe("jc:docs:business:creator");
  expect(resolveConceptId("vector search")).toBe("jc:docs:ai:applied");
});

test("resolveConcepts returns deep concepts ahead of fallback", () => {
  const resolved = resolveConcepts({
    labels: ["game feel", "interactivity", "learning theory"],
  });

  expect(resolved.primaryConceptId).toBe("jc:docs:design:game");
  expect(resolved.conceptIds).toContain("jc:docs:design:game");
  expect(resolved.conceptIds).toContain("jc:docs:education:learning-science");
  expect(resolved.conceptSource).toBe("rules");
  expect(resolved.taxonomyVersion).toBe("v1");
});
