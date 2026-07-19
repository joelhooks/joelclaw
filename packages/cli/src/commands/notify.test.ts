import { describe, expect, test } from "bun:test"
import { parseNotifyWaitTimeoutSeconds } from "./notify"

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
