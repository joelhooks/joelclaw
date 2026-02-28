import { describe, expect, test } from "bun:test"
import { __deployAdapterTestUtils } from "../capabilities/adapters/deploy-scripted"
import { __deployTestUtils } from "./deploy"

const { normalizeWaitMs: normalizeAdapterWaitMs } = __deployAdapterTestUtils
const { normalizeWaitMs: normalizeCommandWaitMs, parseOptionalText } = __deployTestUtils

describe("deploy command helpers", () => {
  test("normalizes wait-ms to safe lower bound", () => {
    expect(normalizeCommandWaitMs(1500)).toBe(1500)
    expect(normalizeCommandWaitMs(0)).toBe(250)
    expect(normalizeAdapterWaitMs(-10)).toBe(250)
  })

  test("optional adapter text parser trims and drops empty values", () => {
    expect(parseOptionalText({ _tag: "None" })).toBeUndefined()
    expect(parseOptionalText({ _tag: "Some", value: "  scripted-deploy  " })).toBe("scripted-deploy")
    expect(parseOptionalText({ _tag: "Some", value: "   " })).toBeUndefined()
  })
})
