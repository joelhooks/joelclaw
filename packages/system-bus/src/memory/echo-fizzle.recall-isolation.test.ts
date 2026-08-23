import { expect, test } from "bun:test"

import { trackEchoFizzle } from "./echo-fizzle"

test("flowing-origin IDs never reach the legacy mutation ports", async () => {
  let searches = 0
  let mutations = 0
  const result = await trackEchoFizzle(
    [{ id: "claim:could-collide", observation: "memory phrase with useful words" }],
    "memory phrase with useful words",
    "flowing-memory-recall",
    {
      search: async () => {
        searches += 1
        return { found: 0, hits: [] }
      },
      bulkImport: async () => {
        mutations += 1
        return { success: 0, errors: 0 }
      },
    },
  )
  expect(result).toEqual({ echoes: 0, fizzles: 0 })
  expect(searches).toBe(0)
  expect(mutations).toBe(0)
})

test("a missing legacy document performs no mutation", async () => {
  let mutations = 0
  const result = await trackEchoFizzle(
    [{ id: "legacy-looking-id", observation: "memory phrase with useful words" }],
    "memory phrase with useful words",
    "typesense-recall",
    {
      search: async () => ({ found: 0, hits: [] }),
      bulkImport: async () => {
        mutations += 1
        return { success: 0, errors: 0 }
      },
    },
  )
  expect(result).toEqual({ echoes: 0, fizzles: 0 })
  expect(mutations).toBe(0)
})
