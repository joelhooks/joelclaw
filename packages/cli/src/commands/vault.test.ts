import { describe, expect, test } from "bun:test"
import { __vaultTestUtils } from "./vault"

const {
  ADR_VALID_STATUSES,
  parseAdrFilename,
  normalizeStatusValue,
  findAdrNumberCollisions,
  parseAdrReadmeRows,
  parseAdrSections,
  parseWikiLinks,
  buildVaultPathIndex,
  resolveWikiLink,
  findAdrSectionMatches,
  parseStatusFilterList,
  parsePriorityBand,
  derivePriorityBand,
  computePriorityScore,
} = __vaultTestUtils

describe("vault ADR filename parsing", () => {
  test("parses canonical ADR filename", () => {
    expect(parseAdrFilename("0168-convex-canonical-content-lifecycle.md")).toEqual({
      number: "0168",
      slug: "convex-canonical-content-lifecycle",
    })
  })

  test("ignores non-ADR filenames", () => {
    expect(parseAdrFilename("README.md")).toBeNull()
    expect(parseAdrFilename("adrs-0168.md")).toBeNull()
  })
})

describe("vault ADR status normalization", () => {
  test("normalizes casing + quotes", () => {
    expect(normalizeStatusValue('"Shipped"')).toBe("shipped")
    expect(normalizeStatusValue("'ACCEPTED'"))
      .toBe("accepted")
  })

  test("retains null values", () => {
    expect(normalizeStatusValue(null)).toBeNull()
  })

  test("canonical status set remains stable", () => {
    expect(ADR_VALID_STATUSES).toEqual([
      "proposed",
      "accepted",
      "shipped",
      "superseded",
      "deprecated",
      "rejected",
    ])
  })
})

describe("vault ADR collision detection", () => {
  test("groups duplicate ADR numbers", () => {
    const collisions = findAdrNumberCollisions([
      { number: "0153", filename: "0153-pdf-brain-rest-api.md" },
      { number: "0153", filename: "0153-secret-redaction-network-intercept.md" },
      { number: "0168", filename: "0168-convex-canonical-content-lifecycle.md" },
      { number: "0088", filename: "0088-a.md" },
      { number: "0088", filename: "0088-b.md" },
    ])

    expect(collisions).toEqual([
      {
        number: "0088",
        files: ["0088-a.md", "0088-b.md"],
      },
      {
        number: "0153",
        files: ["0153-pdf-brain-rest-api.md", "0153-secret-redaction-network-intercept.md"],
      },
    ])
  })
})

describe("vault ADR README row parsing", () => {
  test("extracts linked filenames", () => {
    const markdown = [
      "| ADR | Title | Status | Date |",
      "|-----|-------|--------|------|",
      "| [0168](0168-convex-canonical-content-lifecycle.md) | Convex canonical | shipped | 2026-02-28 |",
      "| [0173](0173-adr-number-collision-remediation.md) | ADR collision remediation | proposed | 2026-02-28 |",
    ].join("\n")

    expect(parseAdrReadmeRows(markdown)).toEqual([
      "0168-convex-canonical-content-lifecycle.md",
      "0173-adr-number-collision-remediation.md",
    ])
  })
})

describe("vault ADR graph helpers", () => {
  const adrItem = {
    number: "0189",
    slug: "gateway-guardrails",
    filename: "0189-gateway-guardrails.md",
    path: "/Users/joel/Vault/docs/decisions/0189-gateway-guardrails.md",
    title: "Gateway Guardrails",
    status: "accepted",
    date: "2026-03-01",
    supersededByRaw: null,
    frontmatter: {},
  }

  test("parses ADR sections with file root plus nested heading ids", () => {
    const markdown = [
      "# ADR-0189: Gateway Guardrails",
      "",
      "Short summary.",
      "",
      "## Context",
      "Why this exists.",
      "",
      "### Constraints",
      "Be explicit.",
    ].join("\n")

    expect(parseAdrSections(adrItem, markdown)).toEqual([
      expect.objectContaining({
        id: "0189-gateway-guardrails",
        kind: "file",
      }),
      expect.objectContaining({
        id: "0189-gateway-guardrails#Context",
        kind: "section",
        body: "Why this exists.",
      }),
      expect.objectContaining({
        id: "0189-gateway-guardrails#Context#Constraints",
        kind: "section",
        body: "Be explicit.",
      }),
    ])
  })

  test("locates ADR files and sections by number and heading text", () => {
    const sections = parseAdrSections(adrItem, [
      "# ADR-0189: Gateway Guardrails",
      "",
      "## Context",
      "Why this exists.",
      "",
      "## Decision",
      "Do the thing.",
    ].join("\n"))

    expect(findAdrSectionMatches([adrItem], sections, "ADR-0189")[0]?.section.id).toBe("0189-gateway-guardrails")
    expect(findAdrSectionMatches([adrItem], sections, "Context")[0]?.section.id).toBe("0189-gateway-guardrails#Context")
  })

  test("parses and resolves wiki links against Vault paths", () => {
    const links = parseWikiLinks([
      "See [[0189-gateway-guardrails]].",
      "Check [[../../Projects/09-joelclaw/index]].",
      "[[tts:text]]ignore this[[/tts:text]]",
    ].join("\n"))

    const pathIndex = buildVaultPathIndex([
      "/Users/joel/Vault/docs/decisions/0189-gateway-guardrails.md",
      "/Users/joel/Vault/Projects/09-joelclaw/index.md",
    ], [adrItem])

    const sections = parseAdrSections(adrItem, "# ADR-0189: Gateway Guardrails\n")

    expect(resolveWikiLink(links[0], adrItem.path, sections, pathIndex)).toEqual(expect.objectContaining({
      status: "resolved",
      canonical: "0189-gateway-guardrails",
      linkType: "adr",
    }))

    expect(resolveWikiLink(links[1], adrItem.path, sections, pathIndex)).toEqual(expect.objectContaining({
      status: "resolved",
      linkType: "vault",
    }))

    expect(resolveWikiLink(links[2], adrItem.path, sections, pathIndex)).toEqual({
      status: "skipped",
      reason: "custom_directive",
    })
  })
})

describe("vault ADR rank rubric helpers", () => {
  test("parses comma/space separated status filters", () => {
    expect(parseStatusFilterList("accepted, proposed shipped")).toEqual([
      "accepted",
      "proposed",
      "shipped",
    ])
  })

  test("maps score to rubric band", () => {
    expect(derivePriorityBand(81)).toBe("do-now")
    expect(derivePriorityBand(70)).toBe("do-next")
    expect(derivePriorityBand(50)).toBe("de-risk")
    expect(derivePriorityBand(20)).toBe("park")
  })

  test("accepts only canonical priority bands", () => {
    expect(parsePriorityBand("do-now")).toBe("do-now")
    expect(parsePriorityBand("do-next")).toBe("do-next")
    expect(parsePriorityBand("NEXT")).toBe("do-next")
    expect(parsePriorityBand("wild")).toBeNull()
  })

  test("computes novelty-adjusted score", () => {
    const base = computePriorityScore({ need: 3, readiness: 5, confidence: 5, novelty: 3 })
    const cool = computePriorityScore({ need: 3, readiness: 5, confidence: 5, novelty: 5 })
    const stale = computePriorityScore({ need: 3, readiness: 5, confidence: 5, novelty: 0 })

    expect(base).toBe(80)
    expect(cool).toBe(90)
    expect(stale).toBe(65)
  })
})
