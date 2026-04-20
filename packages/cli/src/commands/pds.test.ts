import { describe, expect, test } from "bun:test"
import { __pdsTestUtils } from "./pds"

describe("pds helpers", () => {
  test("parseLeaseOutput returns raw leased secrets unchanged", () => {
    expect(__pdsTestUtils.parseLeaseOutput("super-secret-value\n")).toBe("super-secret-value")
  })

  test("parseLeaseOutput drops JSON error envelopes from missing secrets", () => {
    expect(
      __pdsTestUtils.parseLeaseOutput(JSON.stringify({
        ok: false,
        error: { message: "secret not found" },
      })),
    ).toBe("")
  })

  test("tokenSummary exposes jwt expiry metadata without leaking payload internals", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url")
    const token = `header.${payload}.signature`

    expect(__pdsTestUtils.tokenSummary(token)).toEqual({
      present: true,
      length: token.length,
      expiresAt: "2027-01-15T08:00:00.000Z",
    })
  })
})
