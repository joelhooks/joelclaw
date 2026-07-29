import { describe, expect, test } from "bun:test"
import {
  MISSING_NOTIFY_KIND_WARNING,
  parseNotifyWaitTimeoutSeconds,
  resolveNotifyKind,
} from "./notify"

describe("notify send kind", () => {
  test("keeps an explicit kind without a warning", () => {
    expect(resolveNotifyKind("alert")).toEqual({ kind: "alert" })
  })

  test("warns and defaults a missing kind to receipt", () => {
    expect(resolveNotifyKind(undefined)).toEqual({
      kind: "receipt",
      warning: MISSING_NOTIFY_KIND_WARNING,
    })
    expect(MISSING_NOTIFY_KIND_WARNING).toContain("2026-08-12")
  })
})

describe("notify wait timeout", () => {
  test("accepts the documented duration syntax", () => {
    expect(parseNotifyWaitTimeoutSeconds("15s")).toBe(15)
    expect(parseNotifyWaitTimeoutSeconds("1m")).toBe(60)
  })

  test("keeps bare seconds compatible and rejects invalid deadlines", () => {
    expect(parseNotifyWaitTimeoutSeconds("15")).toBe(15)
    expect(parseNotifyWaitTimeoutSeconds("0s")).toBeNull()
    expect(parseNotifyWaitTimeoutSeconds("soon")).toBeNull()
  })
})
