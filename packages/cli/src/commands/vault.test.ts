import { describe, expect, test } from "bun:test"
import { __vaultTestUtils } from "./vault"

const {
  ADR_VALID_STATUSES,
  parseAdrFilename,
  normalizeStatusValue,
  findAdrNumberCollisions,
  parseAdrReadmeRows,
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
